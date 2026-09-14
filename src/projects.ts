/* ==================================================================
 * Projects — the boundary everything else sits inside.
 *
 * A project is one teacher's practice. Every student, song, recording,
 * note, lesson and class belongs to exactly one, and nothing crosses.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 *
 *   Every request acts inside exactly one project, and the acting
 *   project is always proved against the database — never taken from
 *   the browser.
 *
 * The browser does say which project it would like, in a cookie. That
 * cookie is a preference, not a permission: `resolveProject` looks up
 * whether this person is actually a member of it (or an admin) and
 * falls back if not. A cookie a student edits by hand gets them
 * nowhere.
 *
 * Identity is global, membership is per-project. One Google account can
 * be a student of two teachers, or a teacher here and a student there,
 * so "are you a teacher?" is never a question about a person — only
 * about a person *in a project*.
 * ================================================================== */

import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv, Env, User } from './types';
import { newId, now } from './util';

type Ctx = Context<AppEnv, any, any>;

const PROJECT_COOKIE = 'sruti_project';

export interface Project {
  id: string;
  name: string;
  name_ml: string | null;
  status: 'active' | 'archived';
  note: string | null;
  created_by: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface Membership {
  id: string;
  project_id: string;
  user_id: string;
  role: 'teacher' | 'student';
  status: 'pending' | 'active' | 'paused' | 'graduated' | 'ended' | 'disabled';
  status_note: string | null;
  status_changed_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  joined_at: string;
}

/** A membership with the project it is in, for menus and landing pages. */
export interface MembershipWithProject extends Membership {
  project_name: string;
  project_name_ml: string | null;
  project_status: string;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export async function getProject(env: Env, id: string): Promise<Project | null> {
  return env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<Project>();
}

export async function listProjects(env: Env, includeArchived = false): Promise<Project[]> {
  const r = await env.DB.prepare(
    includeArchived
      ? 'SELECT * FROM projects ORDER BY status, name COLLATE NOCASE'
      : "SELECT * FROM projects WHERE status = 'active' ORDER BY name COLLATE NOCASE",
  ).all<Project>();
  return r.results ?? [];
}

/**
 * Every project this person can currently act in. Pending and disabled
 * memberships are left out: they are not yet, or no longer, a way in.
 */
export async function membershipsFor(env: Env, userId: string): Promise<MembershipWithProject[]> {
  const r = await env.DB.prepare(
    `SELECT m.*, p.name AS project_name, p.name_ml AS project_name_ml, p.status AS project_status
       FROM project_members m
       JOIN projects p ON p.id = m.project_id
      WHERE m.user_id = ?1
        AND m.status IN ('active','paused','graduated','ended')
        AND p.status = 'active'
      ORDER BY m.role DESC, p.name COLLATE NOCASE`,
  )
    .bind(userId)
    .all<MembershipWithProject>();
  return r.results ?? [];
}

export async function membershipIn(
  env: Env,
  projectId: string,
  userId: string,
): Promise<Membership | null> {
  return env.DB.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?')
    .bind(projectId, userId)
    .first<Membership>();
}

/* ------------------------------------------------------------------ *
 * Which project is this request acting in?
 * ------------------------------------------------------------------ */

export interface Acting {
  project: Project;
  /** Null when an admin is visiting a project they are not a member of. */
  membership: Membership | null;
  /** May they do teacher things here? */
  isTeacher: boolean;
  /** An admin inside a project they do not teach — every change is logged. */
  asAdmin: boolean;
}

export function setActiveProject(c: Ctx, projectId: string): void {
  setCookie(c, PROJECT_COOKIE, projectId, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
}

export function clearActiveProject(c: Ctx): void {
  deleteCookie(c, PROJECT_COOKIE, { path: '/' });
}

/**
 * The project this request acts in, proved from the database.
 *
 * Order of preference: the cookie, if this person may act there; then
 * their only membership; then nothing. An admin may act in any project,
 * which is the whole point of the admin — but only when the cookie says
 * so, so that admins are not silently dropped into somebody's practice.
 */
export async function resolveProject(c: Ctx, user: User): Promise<Acting | null> {
  const wanted = getCookie(c, PROJECT_COOKIE);
  const isAdmin = Boolean((user as User & { is_admin?: number }).is_admin);

  if (wanted) {
    const p = await getProject(c.env, wanted);
    if (p && p.status === 'active') {
      const m = await membershipIn(c.env, p.id, user.id);
      if (m && ['active', 'paused', 'graduated', 'ended'].includes(m.status)) {
        return { project: p, membership: m, isTeacher: m.role === 'teacher', asAdmin: false };
      }
      if (isAdmin) {
        /* No membership, but an admin who has deliberately switched in.
           Full teacher powers, and every change is recorded. */
        return { project: p, membership: null, isTeacher: true, asAdmin: true };
      }
    }
    /* The cookie names a project they cannot use — a stale switch, an
       archived project, or someone editing cookies. Fall through. */
  }

  const mine = await membershipsFor(c.env, user.id);
  if (mine.length === 1) {
    const only = mine[0];
    const p = await getProject(c.env, only.project_id);
    if (p) return { project: p, membership: only, isTeacher: only.role === 'teacher', asAdmin: false };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export async function createProject(
  env: Env,
  o: { name: string; nameMl?: string | null; note?: string | null; createdBy: string },
): Promise<string> {
  const id = newId('p');
  await env.DB.prepare(
    `INSERT INTO projects (id, name, name_ml, status, note, created_by, created_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
  )
    .bind(id, o.name.trim(), o.nameMl?.trim() || null, o.note?.trim() || null, o.createdBy, now())
    .run();
  return id;
}

export async function addMember(
  env: Env,
  o: {
    projectId: string;
    userId: string;
    role: 'teacher' | 'student';
    status?: Membership['status'];
    approvedBy?: string | null;
  },
): Promise<void> {
  const status = o.status ?? 'active';
  await env.DB.prepare(
    `INSERT INTO project_members
       (id, project_id, user_id, role, status, approved_at, approved_by, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, user_id) DO UPDATE SET
       role = excluded.role,
       status = excluded.status`,
  )
    .bind(
      newId('pm'),
      o.projectId,
      o.userId,
      o.role,
      status,
      status === 'active' ? now() : null,
      o.approvedBy ?? null,
      now(),
    )
    .run();
}

export async function removeMember(env: Env, projectId: string, userId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
    .bind(projectId, userId)
    .run();
}

/* ------------------------------------------------------------------ *
 * The audit trail
 *
 * Only an admin acting inside a project they do not teach is recorded.
 * A teacher working in their own practice is not audited — there would
 * be nobody for them to answer to, and a log nobody reads is noise.
 * ------------------------------------------------------------------ */

export async function logAdmin(
  c: Ctx,
  acting: Acting | null,
  action: string,
  detail: string,
): Promise<void> {
  if (!acting?.asAdmin) return;
  try {
    await c.env.DB.prepare(
      `INSERT INTO admin_log (id, at, actor_id, project_id, action, detail, path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId('al'),
        now(),
        c.get('user').id,
        acting.project.id,
        action,
        detail.slice(0, 500),
        new URL(c.req.url).pathname,
      )
      .run();
  } catch {
    /* An audit write must never take down the change it was recording. */
  }
}

export interface AdminLogRow {
  id: string;
  at: string;
  actor_id: string;
  project_id: string | null;
  action: string;
  detail: string | null;
  path: string | null;
  actor_name: string | null;
}

export async function recentAdminLog(
  env: Env,
  projectId: string,
  limit = 50,
): Promise<AdminLogRow[]> {
  const r = await env.DB.prepare(
    `SELECT l.*, u.name AS actor_name
       FROM admin_log l
       LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.project_id = ?1
      ORDER BY l.at DESC
      LIMIT ?2`,
  )
    .bind(projectId, limit)
    .all<AdminLogRow>();
  return r.results ?? [];
}
