/* ==================================================================
 * മലയാളം — the interface, in Malayalam.
 *
 * FOR THE TEACHER: this is the only file you need to touch to fix the
 * wording. Every line is a pair:
 *
 *     'English as it appears in the app': 'the Malayalam shown instead',
 *
 * Change only the part after the colon — the English on the left is how
 * the app finds the line, so editing it breaks the link and the app
 * quietly falls back to English. Same for a line you delete: nothing
 * breaks, that one phrase just stays in English.
 *
 * %s is a blank the app fills in — a number, a name, a date. Keep every
 * %s that is in the English, and put it where it belongs in Malayalam.
 * Where the order has to change, number them: %1$s is the first blank,
 * %2$s the second.
 *
 * &mdash; and &nbsp; are punctuation the browser draws (a long dash, a
 * space that doesn't break). Leave them as they are.
 *
 * DO NOT put an apostrophe (') inside a line, or a < or & of your own —
 * the file is JavaScript and the app writes these straight into the
 * page. Malayalam needs neither.
 *
 * This file is the chrome only: menus, buttons, headings, hints. Song
 * titles, ragas, composers and the notes you write are shown exactly as
 * you typed them, in both languages.
 * ================================================================== */

export const ML: Record<string, string> = {
  /* ---------------------------------------------------------------- *
   * Small words and fragments
   * ---------------------------------------------------------------- */
  '— a few lines on what this take shows': '— ഈ റെക്കോർഡിംഗിൽ എന്താണുള്ളതെന്ന് രണ്ടു വരി',
  '— finished': '— പൂർത്തിയായി',
  '— for one-offs': '— ഒറ്റത്തവണ ക്ലാസുകൾക്ക്',
  '— Indian time': '— ഇന്ത്യൻ സമയം',
  '— minutes, optional': '— മിനിറ്റ്, നിർബന്ധമില്ല',
  '— none —': '— ഒന്നുമില്ല —',
  '— not set —': '— നൽകിയിട്ടില്ല —',
  '— optional': '— നിർബന്ധമില്ല',
  '— optional, a few lines': '— നിർബന്ധമില്ല, രണ്ടു വരി',
  '— required': '— നിർബന്ധമാണ്',
  '— transliterated': '— ലിപ്യന്തരണം',
  '— what this take is': '— ഈ റെക്കോർഡിംഗ് എന്താണ്',

  /* ---------------------------------------------------------------- *
   * Counts and page titles
   * ---------------------------------------------------------------- */
  '%s · Past classes': '%s · കഴിഞ്ഞ ക്ലാസുകൾ',
  '%s · Schedule': '%s · സമയക്രമം',
  '%s · Settings': '%s · ക്രമീകരണങ്ങൾ',
  '%s · Songs': '%s · പാട്ടുകൾ',
  '%s %s their time': '%s %s അവരുടെ സമയം',
  "%s can't hear this one.": '%s-ന് ഇത് കേൾക്കാനാവില്ല.',
  '%s class': '%s ക്ലാസ്',
  '%s class this week.': 'ഈ ആഴ്ച %s ക്ലാസ്.',
  '%s class.': '%s ക്ലാസ്.',
  '%s classes': '%s ക്ലാസുകൾ',
  '%s classes this week.': 'ഈ ആഴ്ച %s ക്ലാസുകൾ.',
  '%s classes.': '%s ക്ലാസുകൾ.',
  '%s in total, grouped by the part they cover.':
    'ആകെ %s എണ്ണം, പാട്ടിന്റെ ഏതു ഭാഗമെന്ന ക്രമത്തിൽ.',
  '%s match for "%s"': '"%2$s" എന്നതിന് %1$s ഫലം',
  '%s matches for "%s"': '"%2$s" എന്നതിന് %1$s ഫലങ്ങൾ',
  '%s is %s, so these classes are off the calendar &mdash; nothing is deleted, and they come back the moment the status is set to active again.':
    '%s %s ആയതിനാൽ ഈ ക്ലാസുകൾ കലണ്ടറിൽ നിന്ന് മാറ്റിയിരിക്കുന്നു &mdash; ഒന്നും മായ്ച്ചിട്ടില്ല, സ്ഥിതി വീണ്ടും സജീവമാക്കുന്ന നിമിഷം അവ തിരികെ വരും.',
  '%s min': '%s മിനിറ്റ്',
  '%s minutes': '%s മിനിറ്റ്',
  '%s note': '%s കുറിപ്പ്',
  '%s notes': '%s കുറിപ്പുകൾ',
  '%s of 10 GB free tier used': 'സൗജന്യമായ 10 GB-യിൽ %s ഉപയോഗിച്ചു',
  '%s people are waiting to be let in': '%s പേർ അനുമതിക്കായി കാത്തിരിക്കുന്നു',
  '%s person is waiting to be let in': '%s പേർ അനുമതിക്കായി കാത്തിരിക്കുന്നു',
  '%s private recording': '%s സ്വകാര്യ റെക്കോർഡിംഗ്',
  '%s private recordings': '%s സ്വകാര്യ റെക്കോർഡിംഗുകൾ',
  '%s recording': '%s റെക്കോർഡിംഗ്',
  '%s recordings': '%s റെക്കോർഡിംഗുകൾ',
  '%s song': '%s പാട്ട്',
  '%s songs': '%s പാട്ടുകൾ',
  '%s student': '%s വിദ്യാർത്ഥി',
  '%s student has completed this song.': '%s വിദ്യാർത്ഥി ഈ പാട്ട് പൂർത്തിയാക്കി.',
  '%s students': '%s വിദ്യാർത്ഥികൾ',
  '%s students have completed this song.': '%s വിദ്യാർത്ഥികൾ ഈ പാട്ട് പൂർത്തിയാക്കി.',
  '%s to practise, and %s not yet given to %s.':
    'പരിശീലിക്കാൻ %s, %s ഇനിയും %s-ന് നൽകിയിട്ടില്ല.',
  "%s to practise, and %s your teacher hasn't shared yet.":
    'പരിശീലിക്കാൻ %s, %s അധ്യാപകൻ ഇനിയും പങ്കുവെച്ചിട്ടില്ല.',
  '%sm': '%sമി',
  '14 days': '14 ദിവസം',
  '30 days': '30 ദിവസം',

  /* ---------------------------------------------------------------- *
   * Adding things
   * ---------------------------------------------------------------- */
  Account: 'അക്കൗണ്ട്',
  'Add a class slot': 'ഒരു ക്ലാസ് സമയം ചേർക്കുക',
  'Add a group': 'ഒരു ഗ്രൂപ്പ് ചേർക്കുക',
  'Add a new one': 'പുതിയത് ചേർക്കുക',
  'Add a note about the song': 'പാട്ടിനെക്കുറിച്ച് ഒരു കുറിപ്പ് ചേർക്കുക',
  'Add a note for this song': 'ഈ പാട്ടിന് ഒരു കുറിപ്പ് ചേർക്കുക',
  'Add a note on this recording': 'ഈ റെക്കോർഡിംഗിൽ ഒരു കുറിപ്പ് ചേർക്കുക',
  'Add a note to this recording': 'ഈ റെക്കോർഡിംഗിൽ ഒരു കുറിപ്പ് ചേർക്കുക',
  'Add a recording': 'ഒരു റെക്കോർഡിംഗ് ചേർക്കുക',
  'Add a song': 'ഒരു പാട്ട് ചേർക്കുക',
  'Add a student': 'ഒരു വിദ്യാർത്ഥിയെ ചേർക്കുക',
  'Add group': 'ഗ്രൂപ്പ് ചേർക്കുക',
  'Add one below and everyone learning this song will have it.':
    'താഴെ ഒന്ന് ചേർത്താൽ ഈ പാട്ട് പഠിക്കുന്ന എല്ലാവർക്കും അത് ലഭിക്കും.',
  'Add or change slots': 'സമയങ്ങൾ ചേർക്കുകയോ മാറ്റുകയോ ചെയ്യുക',
  'Add slot': 'സമയം ചേർക്കുക',
  'Add song': 'പാട്ട് ചേർക്കുക',
  'Add student': 'വിദ്യാർത്ഥിയെ ചേർക്കുക',
  "Add the Google address you have for a student and they'll be approved automatically the first time they sign in — no second step for you.":
    'വിദ്യാർത്ഥിയുടെ ഗൂഗിൾ വിലാസം ചേർക്കുക; ആദ്യമായി പ്രവേശിക്കുമ്പോൾ തന്നെ അവർക്ക് സ്വയമേവ അനുമതി ലഭിക്കും — നിങ്ങൾക്ക് രണ്ടാമതൊരു പണിയില്ല.',
  "Add the Google address you have for them. They're approved the moment they first sign in, so there's no second step for you.":
    'അവരുടെ ഗൂഗിൾ വിലാസം ചേർക്കുക. ആദ്യമായി പ്രവേശിക്കുന്ന നിമിഷം തന്നെ അനുമതി ലഭിക്കും, അതിനാൽ നിങ്ങൾക്ക് രണ്ടാമതൊരു പണിയില്ല.',
  'After your next class with %s, write down what you covered and where you stopped. It shows up here, so you can pick straight up next time.':
    '%s-യുമായുള്ള അടുത്ത ക്ലാസിനു ശേഷം, എന്തു പഠിപ്പിച്ചു എവിടെ നിർത്തി എന്ന് എഴുതിവെക്കുക. അത് ഇവിടെ കാണും, അടുത്ത തവണ അവിടെനിന്ന് തുടരാം.',
  'All %s past classes': 'കഴിഞ്ഞ %s ക്ലാസുകളും',
  'All previous lessons': 'മുൻപത്തെ എല്ലാ ക്ലാസുകളും',
  'All songs': 'എല്ലാ പാട്ടുകളും',
  'Almost there': 'ഏകദേശം എത്തി',
  'Anupallavi — gamaka': 'അനുപല്ലവി — ഗമകം',
  'Anupallavi at half speed. The gamaka before the arohanam is held longer than the notation suggests.':
    'അനുപല്ലവി പകുതി വേഗത്തിൽ. ആരോഹണത്തിനു മുൻപുള്ള ഗമകം എഴുതിയതിനെക്കാൾ നീട്ടിപ്പിടിക്കണം.',
  Approvals: 'അനുമതികൾ',
  'Approve as student': 'വിദ്യാർത്ഥിയായി അനുവദിക്കുക',
  'As soon as your teacher adds a recording, it appears here.':
    'അധ്യാപകൻ ഒരു റെക്കോർഡിംഗ് ചേർക്കുന്ന മാത്രയിൽ അത് ഇവിടെ കാണാം.',
  "Ask them to open this site and sign in with Google. They'll appear under Approvals, and you decide who gets in.":
    'ഈ സൈറ്റ് തുറന്ന് ഗൂഗിൾ ഉപയോഗിച്ച് പ്രവേശിക്കാൻ അവരോട് പറയുക. അവർ അനുമതികളിൽ വരും, ആരെ കയറ്റണമെന്ന് നിങ്ങൾ തീരുമാനിക്കാം.',
  Assign: 'നൽകുക',
  'Assign a song': 'ഒരു പാട്ട് നൽകുക',
  'Assign another song': 'മറ്റൊരു പാട്ട് നൽകുക',
  'Assign one': 'ഒന്ന് നൽകുക',
  'Assign to a student': 'ഒരു വിദ്യാർത്ഥിക്ക് നൽകുക',
  'Assigned, nothing recorded yet': 'നൽകിയിട്ടുണ്ട്, ഇതുവരെ ഒന്നും റെക്കോർഡ് ചെയ്തിട്ടില്ല',
  'Audio becomes MP3 before it uploads.': 'അപ്‌ലോഡ് ചെയ്യുന്നതിനു മുൻപ് ശബ്ദം MP3 ആയി മാറും.',
  'Audio is saved as MP3 so it plays on every phone, including older iPhones.':
    'എല്ലാ ഫോണിലും, പഴയ ഐഫോണുകളിൽ പോലും, കേൾക്കാൻ ശബ്ദം MP3 ആയാണ് സൂക്ഷിക്കുന്നത്.',

  /* ---------------------------------------------------------------- *
   * The lesson log
   * ---------------------------------------------------------------- */
  'Back after exams in June': 'ജൂണിൽ പരീക്ഷ കഴിഞ്ഞ് തിരികെ',
  'Before next time:': 'അടുത്ത തവണയ്ക്ക് മുൻപ്:',
  'Beyond 10 GB it costs about 1.5 cents per gigabyte per month. Playback is always free.':
    '10 GB കഴിഞ്ഞാൽ ഒരു ജിഗാബൈറ്റിന് മാസം ഏകദേശം 1.5 സെന്റ് ചെലവാകും. കേൾക്കുന്നത് എപ്പോഴും സൗജന്യം.',
  'Cancel this class': 'ഈ ക്ലാസ് റദ്ദാക്കുക',
  'Cancel this one class': 'ഈ ഒരു ക്ലാസ് മാത്രം റദ്ദാക്കുക',
  cancelled: 'റദ്ദാക്കി',
  'Carry on from the same place next lesson.': 'അടുത്ത ക്ലാസിൽ ഇതേ സ്ഥലത്തുനിന്ന് തുടരാം.',
  'Carry on from the same place.': 'ഇതേ സ്ഥലത്തുനിന്ന് തുടരാം.',
  Change: 'മാറ്റുക',
  'Change status': 'സ്ഥിതി മാറ്റുക',
  'Check again': 'വീണ്ടും നോക്കുക',
  'Class calendar': 'ക്ലാസ് കലണ്ടർ',
  Clear: 'മായ്ക്കുക',
  'click to open': 'തുറക്കാൻ ഞെക്കുക',
  'Collapse all': 'എല്ലാം ചുരുക്കുക',
  Colours: 'നിറങ്ങൾ',
  'Colours and language': 'നിറങ്ങളും ഭാഷയും',
  completed: 'പൂർത്തിയായി',
  Composer: 'രചയിതാവ്',
  Covered: 'പഠിപ്പിച്ചത്',
  'Covered:': 'പഠിപ്പിച്ചത്:',
  Currently: 'ഇപ്പോൾ',
  Date: 'തീയതി',
  Day: 'ദിവസം',

  /* ---------------------------------------------------------------- *
   * Deleting and editing
   * ---------------------------------------------------------------- */
  Delete: 'മായ്ക്കുക',
  'Delete %s? Every recording and note filed under it will be deleted too.':
    '%s മായ്ക്കണോ? അതിനു കീഴിലുള്ള എല്ലാ റെക്കോർഡിംഗുകളും കുറിപ്പുകളും ഒപ്പം മായ്ക്കപ്പെടും.',
  'Delete group': 'ഗ്രൂപ്പ് മായ്ക്കുക',
  'Delete lesson': 'ക്ലാസ് മായ്ക്കുക',
  'Delete note': 'കുറിപ്പ് മായ്ക്കുക',
  'Delete recording': 'റെക്കോർഡിംഗ് മായ്ക്കുക',
  'Delete this group? The songs in it stay, but lose their group.':
    'ഈ ഗ്രൂപ്പ് മായ്ക്കണോ? അതിലെ പാട്ടുകൾ നിലനിൽക്കും, പക്ഷേ ഗ്രൂപ്പ് ഇല്ലാതാകും.',
  'Delete this lesson from the log?': 'ഈ ക്ലാസ് രേഖയിൽ നിന്ന് മായ്ക്കണോ?',
  'Delete this note?': 'ഈ കുറിപ്പ് മായ്ക്കണോ?',
  'Delete this recording permanently?': 'ഈ റെക്കോർഡിംഗ് എന്നെന്നേക്കുമായി മായ്ക്കണോ?',
  'Delete this song': 'ഈ പാട്ട് മായ്ക്കുക',
  'Delete this song and every recording and note filed under it?':
    'ഈ പാട്ടും അതിനു കീഴിലുള്ള എല്ലാ റെക്കോർഡിംഗുകളും കുറിപ്പുകളും മായ്ക്കണോ?',
  Description: 'വിവരണം',
  Details: 'വിശദാംശങ്ങൾ',
  'different day': 'വേറൊരു ദിവസം',
  Discard: 'ഉപേക്ഷിക്കുക',
  Download: 'ഡൗൺലോഡ്',
  'Download image': 'ചിത്രം ഡൗൺലോഡ് ചെയ്യുക',
  'Download note': 'കുറിപ്പ് ഡൗൺലോഡ് ചെയ്യുക',
  'Drop audio or video here': 'ശബ്ദമോ വീഡിയോയോ ഇവിടെ ഇടുക',
  "Each one is named after its file; rename it afterwards if that isn't right.":
    'ഓരോന്നിനും അതിന്റെ ഫയലിന്റെ പേരാണ് വരിക; ശരിയല്ലെങ്കിൽ പിന്നീട് പേരു മാറ്റാം.',
  Edit: 'തിരുത്തുക',
  'Edit it': 'തിരുത്തുക',
  'Edit song details': 'പാട്ടിന്റെ വിശദാംശങ്ങൾ തിരുത്തുക',
  'Edit this lesson': 'ഈ ക്ലാസ് തിരുത്തുക',
  'Edit this recording': 'ഈ റെക്കോർഡിംഗ് തിരുത്തുക',
  English: 'ഇംഗ്ലീഷ്',
  'Every %s': 'എല്ലാ %s-ഉം',
  'Every class that happened, was missed, or was cancelled.':
    'നടന്നതും മുടങ്ങിയതും റദ്ദാക്കിയതുമായ എല്ലാ ക്ലാസുകളും.',
  'Every class, most recent first. An ongoing one is a lesson to carry on from.':
    'എല്ലാ ക്ലാസുകളും, ഏറ്റവും പുതിയത് ആദ്യം. നടന്നുകൊണ്ടിരിക്കുന്ന ഒന്ന് തുടരാനുള്ള ക്ലാസാണ്.',
  'Every song in the catalogue is already assigned.':
    'പട്ടികയിലെ എല്ലാ പാട്ടുകളും ഇതിനകം നൽകിക്കഴിഞ്ഞു.',
  "Every take needs a name — it's how you'll find it again.":
    'ഓരോ റെക്കോർഡിംഗിനും ഒരു പേരു വേണം — വീണ്ടും കണ്ടെത്താൻ അതാണ് വഴി.',
  'Every week': 'എല്ലാ ആഴ്ചയും',
  everyone: 'എല്ലാവർക്കും',
  'Everyone learning this song': 'ഈ പാട്ട് പഠിക്കുന്ന എല്ലാവരും',
  'Everyone you teach. Open a student to assign songs and add recordings.':
    'നിങ്ങൾ പഠിപ്പിക്കുന്ന എല്ലാവരും. പാട്ടുകൾ നൽകാനും റെക്കോർഡിംഗുകൾ ചേർക്കാനും ഒരു വിദ്യാർത്ഥിയെ തുറക്കുക.',
  "Everything your teacher has recorded for you. Slow any of them down without changing the pitch, and loop the phrase you're working on.":
    'അധ്യാപകൻ നിങ്ങൾക്കായി റെക്കോർഡ് ചെയ്ത എല്ലാം. ശ്രുതി മാറാതെ ഏതും പതുക്കെയാക്കാം, പരിശീലിക്കുന്ന സംഗതി വീണ്ടും വീണ്ടും കേൾക്കാം.',
  'Expand all': 'എല്ലാം തുറക്കുക',

  /* ---------------------------------------------------------------- *
   * Filling in a lesson
   * ---------------------------------------------------------------- */
  'Fill this in at the end and the stopping point carries into next week.':
    'അവസാനം ഇത് എഴുതിയാൽ നിർത്തിയ സ്ഥലം അടുത്ത ആഴ്ചയിലേക്ക് പോകും.',
  "Filled in automatically the first time they open the site. Change it only if that's wrong, or if they've moved.":
    'അവർ സൈറ്റ് ആദ്യമായി തുറക്കുമ്പോൾ ഇത് സ്വയമേവ വരും. തെറ്റാണെങ്കിലോ അവർ സ്ഥലം മാറിയെങ്കിലോ മാത്രം മാറ്റുക.',
  "Filled in from your browser the first time you signed in. Change it here if you've moved — it won't be overwritten.":
    'ആദ്യമായി പ്രവേശിച്ചപ്പോൾ നിങ്ങളുടെ ബ്രൗസറിൽ നിന്ന് എടുത്തതാണ്. സ്ഥലം മാറിയെങ്കിൽ ഇവിടെ മാറ്റാം — അത് പിന്നീട് മായ്ക്കപ്പെടില്ല.',
  finished: 'പൂർത്തിയായി',
  Finished: 'പൂർത്തിയായവ',
  'finished %s': '%s പൂർത്തിയാക്കി',
  'Finished it': 'പൂർത്തിയാക്കി',
  'Finished what we planned': 'നിശ്ചയിച്ചത് പൂർത്തിയാക്കി',
  'for %s': '%s-ന്',
  'from %s': '%s മുതൽ',
  'From the catalogue': 'പട്ടികയിൽ നിന്ന്',
  'Go back': 'തിരികെ പോകുക',
  'Google email': 'ഗൂഗിൾ ഇമെയിൽ',
  Group: 'ഗ്രൂപ്പ്',
  'Group name': 'ഗ്രൂപ്പിന്റെ പേര്',
  'Group songs however you actually teach — by stage, by raga, by whatever you call it.':
    'നിങ്ങൾ പഠിപ്പിക്കുന്ന രീതിയിൽ പാട്ടുകൾ ഗ്രൂപ്പാക്കുക — ഘട്ടം അനുസരിച്ചോ, രാഗം അനുസരിച്ചോ, നിങ്ങൾ വിളിക്കുന്ന പേരിലോ.',
  'has not signed in yet': 'ഇതുവരെ പ്രവേശിച്ചിട്ടില്ല',
  'has signed in with Google': 'ഗൂഗിൾ ഉപയോഗിച്ച് പ്രവേശിച്ചു',
  Heading: 'തലക്കെട്ട്',
  held: 'നടന്നു',
  'How did it end?': 'എങ്ങനെയാണ് അവസാനിച്ചത്?',
  'How long': 'എത്ര നേരം',
  "If it isn't happening": 'നടക്കുന്നില്ലെങ്കിൽ',
  'In Malayalam': 'മലയാളത്തിൽ',
  'In your own time — set your time zone below so these are right.':
    'നിങ്ങളുടെ സ്വന്തം സമയത്തിൽ — ഇവ ശരിയാകാൻ താഴെ നിങ്ങളുടെ സമയമേഖല നൽകുക.',
  'In your own time.': 'നിങ്ങളുടെ സ്വന്തം സമയത്തിൽ.',
  'Include paused, graduated and ended': 'നിർത്തിവെച്ചവരും പഠിച്ചിറങ്ങിയവരും അവസാനിപ്പിച്ചവരും ഉൾപ്പെടെ',
  'Invite someone by email': 'ഇമെയിൽ വഴി ഒരാളെ ക്ഷണിക്കുക',
  'joined %s': '%s ചേർന്നു',
  'Just once': 'ഒരു തവണ മാത്രം',
  Label: 'പേര്',
  Language: 'ഭാഷ',
  'last added %s': 'അവസാനം ചേർത്തത് %s',
  'Last lesson': 'കഴിഞ്ഞ ക്ലാസ്',
  'Learning now': 'ഇപ്പോൾ പഠിക്കുന്നത്',
  'Learning this now': 'ഇത് ഇപ്പോൾ പഠിക്കുന്നവർ',
  Length: 'ദൈർഘ്യം',
  lessons: 'ക്ലാസുകൾ',
  Lessons: 'ക്ലാസുകൾ',
  'Light or dark': 'വെളിച്ചമോ ഇരുട്ടോ',
  'List view': 'പട്ടികയായി',
  Listen: 'കേൾക്കുക',
  'Load starter catalogue': 'തുടക്കത്തിനുള്ള പട്ടിക എടുക്കുക',
  'Loads the usual beginner-to-varnam course — sarali, janta, dhatu and sthayi varisai, alankarams, geethams, swarajatis and the Adi and Ata tala varnams, with raga, taala and composer filled in. Nothing is overwritten, and you can edit or delete any of it.':
    'തുടക്കം മുതൽ വർണ്ണം വരെയുള്ള പതിവു പാഠക്രമം എടുക്കുന്നു — സരളി, ജണ്ട, ധാതു, സ്ഥായി വരിശകൾ, അലങ്കാരങ്ങൾ, ഗീതങ്ങൾ, സ്വരജതികൾ, ആദി-അട താള വർണ്ണങ്ങൾ; രാഗവും താളവും രചയിതാവും ചേർത്ത്. ഒന്നും മായ്ക്കപ്പെടില്ല, ഏതും തിരുത്താനും മായ്ക്കാനും കഴിയും.',
  Lock: 'പൂട്ടുക',
  Log: 'രേഖപ്പെടുത്തുക',
  'Log a lesson': 'ഒരു ക്ലാസ് രേഖപ്പെടുത്തുക',
  'Log the next lesson': 'അടുത്ത ക്ലാസ് രേഖപ്പെടുത്തുക',
  'Log this lesson': 'ഈ ക്ലാസ് രേഖപ്പെടുത്തുക',
  Loop: 'ആവർത്തനം',

  /* ---------------------------------------------------------------- *
   * Moving and marking
   * ---------------------------------------------------------------- */
  'Make teacher': 'അധ്യാപകനാക്കുക',
  'Manage weekly slots': 'ആഴ്ചയിലെ സമയങ്ങൾ ക്രമീകരിക്കുക',
  'Mark finished': 'പൂർത്തിയായി എന്ന് അടയാളപ്പെടുത്തുക',
  'Mark missed': 'മുടങ്ങി എന്ന് അടയാളപ്പെടുത്തുക',
  'Mark this lesson finished': 'ഈ ക്ലാസ് പൂർത്തിയായി എന്ന് അടയാളപ്പെടുത്തുക',
  'Midway through the second sangati — start there next time.':
    'രണ്ടാമത്തെ സംഗതിയുടെ പകുതിയിൽ — അടുത്ത തവണ അവിടെനിന്ന് തുടങ്ങാം.',
  'Midway through the second sangati — the phrase before the arohanam still needs work.':
    'രണ്ടാമത്തെ സംഗതിയുടെ പകുതിയിൽ — ആരോഹണത്തിനു മുൻപുള്ള ഭാഗം ഇനിയും പണിയെടുക്കണം.',
  missed: 'മുടങ്ങി',
  Move: 'മാറ്റുക',
  'Move class': 'ക്ലാസ് മാറ്റുക',
  'Move down': 'താഴേക്ക് മാറ്റുക',
  'Move down within %s': '%s-ൽ താഴേക്ക് മാറ്റുക',
  'Move down within this group': 'ഈ ഗ്രൂപ്പിനുള്ളിൽ താഴേക്ക് മാറ്റുക',
  'Move this group down': 'ഈ ഗ്രൂപ്പ് താഴേക്ക് മാറ്റുക',
  'Move this group up': 'ഈ ഗ്രൂപ്പ് മുകളിലേക്ക് മാറ്റുക',
  'Move up': 'മുകളിലേക്ക് മാറ്റുക',
  'Move up within %s': '%s-ൽ മുകളിലേക്ക് മാറ്റുക',
  'Move up within this group': 'ഈ ഗ്രൂപ്പിനുള്ളിൽ മുകളിലേക്ക് മാറ്റുക',
  moved: 'മാറ്റി',
  'moved here': 'ഇവിടേക്ക് മാറ്റി',
  'My songs': 'എന്റെ പാട്ടുകൾ',
  Name: 'പേര്',
  'Name this take': 'ഈ റെക്കോർഡിംഗിന് പേരിടുക',
  'Name, email, place or number…': 'പേര്, ഇമെയിൽ, സ്ഥലം അല്ലെങ്കിൽ നമ്പർ…',
  'Next 7 days': 'അടുത്ത 7 ദിവസം',
  'Next class': 'അടുത്ത ക്ലാസ്',
  'Next classes': 'അടുത്ത ക്ലാസുകൾ',
  'Next week': 'അടുത്ത ആഴ്ച',

  /* ---------------------------------------------------------------- *
   * Nothing here yet
   * ---------------------------------------------------------------- */
  'no class': 'ക്ലാസില്ല',
  'No class this day': 'ഈ ദിവസം ക്ലാസില്ല',
  'No classes logged yet.': 'ഇതുവരെ ഒരു ക്ലാസും രേഖപ്പെടുത്തിയിട്ടില്ല.',
  'No classes on this day.': 'ഈ ദിവസം ക്ലാസുകളില്ല.',
  'No classes today.': 'ഇന്ന് ക്ലാസുകളില്ല.',
  'No lessons logged yet': 'ഇതുവരെ ഒരു ക്ലാസും രേഖപ്പെടുത്തിയിട്ടില്ല',
  'No lessons logged yet.': 'ഇതുവരെ ഒരു ക്ലാസും രേഖപ്പെടുത്തിയിട്ടില്ല.',
  'No note was left about where you stopped.': 'എവിടെ നിർത്തി എന്ന് കുറിപ്പൊന്നും ഇല്ല.',
  'No notes about the song yet.': 'പാട്ടിനെക്കുറിച്ച് ഇതുവരെ കുറിപ്പുകളില്ല.',
  'No part set': 'ഭാഗം നൽകിയിട്ടില്ല',
  'No previous lesson logged for %s.': '%s-ന് മുൻപത്തെ ക്ലാസൊന്നും രേഖപ്പെടുത്തിയിട്ടില്ല.',
  'No recordings yet': 'ഇതുവരെ റെക്കോർഡിംഗുകളില്ല',
  'No slots set up yet.': 'ഇതുവരെ സമയങ്ങളൊന്നും നിശ്ചയിച്ചിട്ടില്ല.',
  'No slots yet.': 'ഇതുവരെ സമയങ്ങളില്ല.',
  'No songs assigned yet.': 'ഇതുവരെ പാട്ടുകളൊന്നും നൽകിയിട്ടില്ല.',
  'No songs match "%s"': '"%s" എന്നതിനോട് ചേരുന്ന പാട്ടുകളില്ല',
  'no stopping point noted': 'നിർത്തിയ സ്ഥലം കുറിച്ചിട്ടില്ല',
  'No students yet': 'ഇതുവരെ വിദ്യാർത്ഥികളില്ല',
  'No students yet.': 'ഇതുവരെ വിദ്യാർത്ഥികളില്ല.',
  'Nobody is assigned this song yet, so there is no one to choose from. Until then this %s is for everyone learning it.':
    'ഈ പാട്ട് ഇതുവരെ ആർക്കും നൽകിയിട്ടില്ല, അതിനാൽ തിരഞ്ഞെടുക്കാൻ ആരുമില്ല. അതുവരെ ഈ %s ഇത് പഠിക്കുന്ന എല്ലാവർക്കുമുള്ളതാണ്.',
  'Nobody is on this song at the moment.': 'ഇപ്പോൾ ആരും ഈ പാട്ടിലില്ല.',
  'Nobody matches "%s"': '"%s" എന്നതിനോട് ചേരുന്ന ആരുമില്ല',
  'Nobody sees a single recording until you approve them here.':
    'ഇവിടെ നിങ്ങൾ അനുവദിക്കുന്നതുവരെ ആരും ഒരു റെക്കോർഡിംഗും കാണില്ല.',
  'Nobody waiting': 'ആരും കാത്തിരിക്കുന്നില്ല',
  'nobody yet': 'ഇതുവരെ ആരുമില്ല',
  'Not found': 'കണ്ടെത്തിയില്ല',
  'Not here': 'ഇവിടെയില്ല',
  'Not shared with them': 'അവരുമായി പങ്കുവെച്ചിട്ടില്ല',
  'Not yet shared with you': 'ഇതുവരെ നിങ്ങളുമായി പങ്കുവെച്ചിട്ടില്ല',
  Note: 'കുറിപ്പ്',
  note: 'കുറിപ്പ്',
  'Note attachment': 'കുറിപ്പിനൊപ്പമുള്ള ചിത്രം',
  Notes: 'കുറിപ്പുകൾ',
  'Notes about the whole song': 'പാട്ടിനെ മൊത്തത്തിൽ കുറിച്ചുള്ള കുറിപ്പുകൾ',
  'Notes on this recording': 'ഈ റെക്കോർഡിംഗിലെ കുറിപ്പുകൾ',
  'Notes that belong to one take live with it, above.':
    'ഒരു റെക്കോർഡിംഗിന്റേതു മാത്രമായ കുറിപ്പുകൾ മുകളിൽ അതിനൊപ്പമുണ്ട്.',
  'Nothing assigned yet.': 'ഇതുവരെ ഒന്നും നൽകിയിട്ടില്ല.',
  'Nothing coming up.': 'വരാനൊന്നുമില്ല.',
  'Nothing here yet': 'ഇവിടെ ഇതുവരെ ഒന്നുമില്ല',
  'Nothing in progress.': 'ഒന്നും നടന്നുകൊണ്ടിരിക്കുന്നില്ല.',
  'Nothing in this group yet.': 'ഈ ഗ്രൂപ്പിൽ ഇതുവരെ ഒന്നുമില്ല.',
  'Nothing is deleted. Their recordings, lesson history and schedule stay, and they can be made active again at any time.':
    'ഒന്നും മായ്ക്കപ്പെടുന്നില്ല. അവരുടെ റെക്കോർഡിംഗുകളും ക്ലാസ് ചരിത്രവും സമയക്രമവും നിലനിൽക്കും, എപ്പോൾ വേണമെങ്കിലും വീണ്ടും സജീവമാക്കാം.',
  'Nothing matches "%s"': '"%s" എന്നതിനോട് ഒന്നും ചേരുന്നില്ല',
  'Nothing scheduled': 'ഒന്നും നിശ്ചയിച്ചിട്ടില്ല',
  'Nothing to play yet': 'ഇതുവരെ കേൾക്കാൻ ഒന്നുമില്ല',
  'Nothing to practise yet': 'ഇതുവരെ പരിശീലിക്കാൻ ഒന്നുമില്ല',
  'Nothing was noted about where you stopped.': 'എവിടെ നിർത്തി എന്ന് ഒന്നും കുറിച്ചിട്ടില്ല.',
  'Nothing written about this take yet.': 'ഈ റെക്കോർഡിംഗിനെക്കുറിച്ച് ഇതുവരെ ഒന്നും എഴുതിയിട്ടില്ല.',

  /* ---------------------------------------------------------------- *
   * Opening things
   * ---------------------------------------------------------------- */
  'Onam, travelling…': 'ഓണം, യാത്ര…',
  'Once on %s': '%s-ന് ഒരു തവണ',
  'One shared list. Assigning a song to a student is a separate step, so the same song can sit at a different stage for each of them.':
    'എല്ലാവർക്കുമായി ഒരൊറ്റ പട്ടിക. ഒരു പാട്ട് വിദ്യാർത്ഥിക്ക് നൽകുന്നത് വേറൊരു പടിയാണ്, അതിനാൽ ഒരേ പാട്ട് ഓരോരുത്തർക്കും വെവ്വേറെ ഘട്ടത്തിൽ നിൽക്കാം.',
  ongoing: 'നടന്നുകൊണ്ടിരിക്കുന്നു',
  'Only the name and email are needed — the rest can wait.':
    'പേരും ഇമെയിലും മാത്രം മതി — ബാക്കി പിന്നീടാകാം.',
  'Only the students I tick': 'ഞാൻ അടയാളപ്പെടുത്തുന്ന വിദ്യാർത്ഥികൾക്ക് മാത്രം',
  Open: 'തുറക്കുക',
  'Open a group to see its songs.': 'അതിലെ പാട്ടുകൾ കാണാൻ ഒരു ഗ്രൂപ്പ് തുറക്കുക.',
  "Open one to play it, read its notes, and set who it's for.":
    'കേൾക്കാനും കുറിപ്പുകൾ വായിക്കാനും ആർക്കുള്ളതെന്ന് നിശ്ചയിക്കാനും ഒന്ന് തുറക്കുക.',
  'Open one to play its recordings and read its notes.':
    'റെക്കോർഡിംഗുകൾ കേൾക്കാനും കുറിപ്പുകൾ വായിക്കാനും ഒന്ന് തുറക്കുക.',
  'Open this class': 'ഈ ക്ലാസ് തുറക്കുക',
  'Open WhatsApp': 'വാട്‌സ്ആപ്പ് തുറക്കുക',
  'Or a date': 'അല്ലെങ്കിൽ ഒരു തീയതി',
  'or click to choose files — MP3, M4A, WAV, MP4 and MOV all work':
    'അല്ലെങ്കിൽ ഫയലുകൾ തിരഞ്ഞെടുക്കാൻ ഞെക്കുക — MP3, M4A, WAV, MP4, MOV എല്ലാം ചെല്ലും',
  'or click to choose files — MP3, M4A, WAV, MP4 and MOV all work.':
    'അല്ലെങ്കിൽ ഫയലുകൾ തിരഞ്ഞെടുക്കാൻ ഞെക്കുക — MP3, M4A, WAV, MP4, MOV എല്ലാം ചെല്ലും.',
  "Or it didn't happen": 'അല്ലെങ്കിൽ അത് നടന്നില്ല',
  'Or move it': 'അല്ലെങ്കിൽ മാറ്റുക',
  Overview: 'അവലോകനം',
  'Pallavi, slow': 'പല്ലവി, പതുക്കെ',
  'Part of the song': 'പാട്ടിന്റെ ഭാഗം',
  'Past classes': 'കഴിഞ്ഞ ക്ലാസുകൾ',
  'Pick up from here': 'ഇവിടെനിന്ന് തുടരുക',
  'Previous week': 'കഴിഞ്ഞ ആഴ്ച',
  'Put it back': 'തിരികെ വെക്കുക',

  /* ---------------------------------------------------------------- *
   * Recording
   * ---------------------------------------------------------------- */
  Raga: 'രാഗം',
  'Raga %s': 'രാഗം %s',
  Read: 'വായിക്കുക',
  'Ready for something new next time.': 'അടുത്ത തവണ പുതിയതെന്തെങ്കിലും തുടങ്ങാം.',
  'Ready to start something new next time.': 'അടുത്ത തവണ പുതിയതെന്തെങ്കിലും തുടങ്ങാൻ തയ്യാർ.',
  'Reason — Onam, travel…': 'കാരണം — ഓണം, യാത്ര…',
  'Recent classes': 'അടുത്തിടെയുള്ള ക്ലാസുകൾ',
  'Record a take below, or unlock one of the others.':
    'താഴെ ഒരു റെക്കോർഡിംഗ് എടുക്കുക, അല്ലെങ്കിൽ മറ്റൊന്ന് തുറന്നുകൊടുക്കുക.',
  'record in the browser, or drop in files': 'ബ്രൗസറിൽ റെക്കോർഡ് ചെയ്യുക, അല്ലെങ്കിൽ ഫയലുകൾ ഇടുക',
  'Record now': 'ഇപ്പോൾ റെക്കോർഡ് ചെയ്യുക',
  'Record video instead': 'പകരം വീഡിയോ റെക്കോർഡ് ചെയ്യുക',
  'recorded in browser': 'ബ്രൗസറിൽ റെക്കോർഡ് ചെയ്തത്',
  Recording: 'റെക്കോർഡിംഗ്',
  recording: 'റെക്കോർഡിംഗ്',
  Recordings: 'റെക്കോർഡിംഗുകൾ',
  'Recordings and notes from your Carnatic vocal lessons, kept in one place. Sign in with the Google account your teacher has for you.':
    'നിങ്ങളുടെ കർണാടക സംഗീത ക്ലാസുകളിലെ റെക്കോർഡിംഗുകളും കുറിപ്പുകളും ഒരിടത്ത്. അധ്യാപകന്റെ പക്കലുള്ള നിങ്ങളുടെ ഗൂഗിൾ അക്കൗണ്ട് ഉപയോഗിച്ച് പ്രവേശിക്കുക.',
  'Recordings stay available to practise.': 'പരിശീലിക്കാൻ റെക്കോർഡിംഗുകൾ ഇവിടെത്തന്നെ ഉണ്ടാകും.',
  Reject: 'നിരസിക്കുക',
  Remove: 'ഒഴിവാക്കുക',
  'Remove this song from their list? Recordings are kept.':
    'ഈ പാട്ട് അവരുടെ പട്ടികയിൽ നിന്ന് ഒഴിവാക്കണോ? റെക്കോർഡിംഗുകൾ നിലനിൽക്കും.',
  'Remove this weekly slot? Past lessons are untouched.':
    'ആഴ്ചയിലെ ഈ സമയം ഒഴിവാക്കണോ? കഴിഞ്ഞ ക്ലാസുകളെ ഇത് ബാധിക്കില്ല.',
  Reopen: 'വീണ്ടും തുറക്കുക',
  Repeats: 'ആവർത്തനം',
  Reschedule: 'സമയം മാറ്റുക',
  'Reschedule to': 'ഇതിലേക്ക് മാറ്റുക',
  rescheduled: 'സമയം മാറ്റി',
  Review: 'വീണ്ടും നോക്കുക',

  /* ---------------------------------------------------------------- *
   * Saving
   * ---------------------------------------------------------------- */
  'Sarali 1 to 5 daily, slowly, with the tanpura.': 'സരളി 1 മുതൽ 5 വരെ ദിവസവും, പതുക്കെ, തംബുരുവിനൊപ്പം.',
  'Sarali 1 to 7 at two speeds. Started the pallavi of Vatapi.':
    'സരളി 1 മുതൽ 7 വരെ രണ്ട് കാലത്തിൽ. വാതാപിയുടെ പല്ലവി തുടങ്ങി.',
  'Sarali 1 to 7 at two speeds. Started the pallavi.':
    'സരളി 1 മുതൽ 7 വരെ രണ്ട് കാലത്തിൽ. പല്ലവി തുടങ്ങി.',
  Save: 'സേവ് ചെയ്യുക',
  'Save changes': 'മാറ്റങ്ങൾ സേവ് ചെയ്യുക',
  'Save details': 'വിശദാംശങ്ങൾ സേവ് ചെയ്യുക',
  'Save lesson': 'ക്ലാസ് സേവ് ചെയ്യുക',
  'Save note': 'കുറിപ്പ് സേവ് ചെയ്യുക',
  'Save recording': 'റെക്കോർഡിംഗ് സേവ് ചെയ്യുക',
  "Save who it's for": 'ആർക്കുള്ളതെന്ന് സേവ് ചെയ്യുക',
  Schedule: 'സമയക്രമം',
  Screenshot: 'സ്ക്രീൻഷോട്ട്',
  'Screenshot or notation': 'സ്ക്രീൻഷോട്ടോ സ്വരലിപിയോ',
  'Screenshot or photo of notation': 'സ്ക്രീൻഷോട്ടോ സ്വരലിപിയുടെ ചിത്രമോ',
  Search: 'തിരയുക',
  'Search covers the song name in either script, plus raga and composer.':
    'ഏതു ലിപിയിലുള്ള പാട്ടിന്റെ പേരും, ഒപ്പം രാഗവും രചയിതാവും തിരയലിൽ വരും.',
  'Search covers the title in either script, plus raga, taala and composer.':
    'ഏതു ലിപിയിലുള്ള പേരും, ഒപ്പം രാഗം, താളം, രചയിതാവ് എന്നിവയും തിരയലിൽ വരും.',
  'Search your songs by name or raga…': 'പേരോ രാഗമോ വെച്ച് നിങ്ങളുടെ പാട്ടുകൾ തിരയുക…',
  'Second sangati, slowly. Hold the gamaka longer than written.':
    'രണ്ടാമത്തെ സംഗതി, പതുക്കെ. ഗമകം എഴുതിയതിനെക്കാൾ നീട്ടിപ്പിടിക്കുക.',
  'Set A': 'A ഇടുക',
  'Set in Indian time. What %s sees shifts with their own daylight saving.':
    'ഇന്ത്യൻ സമയത്തിലാണ് നിശ്ചയിക്കുന്നത്. %s കാണുന്ന സമയം അവരുടെ നാട്ടിലെ ഡേലൈറ്റ് സേവിംഗ് അനുസരിച്ച് മാറും.',
  'Set on their first sign-in': 'അവർ ആദ്യമായി പ്രവേശിക്കുമ്പോൾ നിശ്ചയിക്കപ്പെടും',
  "Set up each student's weekly slots and they'll appear here.":
    'ഓരോ വിദ്യാർത്ഥിയുടെയും ആഴ്ചയിലെ സമയങ്ങൾ നിശ്ചയിച്ചാൽ അവ ഇവിടെ കാണാം.',
  Settings: 'ക്രമീകരണങ്ങൾ',
  'Sign in': 'പ്രവേശിക്കുക',
  'Sign in with Google': 'ഗൂഗിൾ ഉപയോഗിച്ച് പ്രവേശിക്കുക',
  'Sign out': 'പുറത്തുകടക്കുക',
  'signed in %s': '%s പ്രവേശിച്ചു',
  'since %s': '%s മുതൽ',
  'Sing the second sangati only after the first is steady.':
    'ആദ്യത്തെ സംഗതി ഉറച്ചതിനു ശേഷം മാത്രം രണ്ടാമത്തേത് പാടുക.',
  Songs: 'പാട്ടുകൾ',
  'Songs to work on': 'പണിയെടുക്കാനുള്ള പാട്ടുകൾ',
  'Songs you worked on': 'നിങ്ങൾ പണിയെടുത്ത പാട്ടുകൾ',
  "Songs you've completed. The recordings stay here.":
    'നിങ്ങൾ പൂർത്തിയാക്കിയ പാട്ടുകൾ. റെക്കോർഡിംഗുകൾ ഇവിടെത്തന്നെ ഉണ്ടാകും.',
  'Speak it': 'പറയുക',
  'Speak this in Malayalam': 'ഇത് മലയാളത്തിൽ പറയുക',
  Speed: 'വേഗത',
  'Start by adding a group like "Sarali varisai", then put songs in it.':
    '"സരളി വരിശ" പോലൊരു ഗ്രൂപ്പ് ചേർത്ത് തുടങ്ങുക, എന്നിട്ട് അതിൽ പാട്ടുകൾ ഇടുക.',
  'Start class': 'ക്ലാസ് തുടങ്ങുക',
  'Start from the standard repertoire': 'പതിവു പാഠക്രമത്തിൽ നിന്ന് തുടങ്ങുക',
  'Start recording': 'റെക്കോർഡിംഗ് തുടങ്ങുക',
  Status: 'സ്ഥിതി',
  'still in progress': 'ഇനിയും നടന്നുകൊണ്ടിരിക്കുന്നു',
  'Still in the middle of it': 'ഇനിയും അതിന്റെ നടുവിലാണ്',
  Stop: 'നിർത്തുക',
  'Stopped at': 'നിർത്തിയത്',
  Storage: 'സംഭരണം',
  'Struck through means no class; amber means moved; red means missed.':
    'വരയിട്ടത് ക്ലാസില്ല എന്നാണ്; മഞ്ഞ മാറ്റിയത്; ചുവപ്പ് മുടങ്ങിയത്.',
  Student: 'വിദ്യാർത്ഥി',
  'Student unwell, no-show…': 'വിദ്യാർത്ഥിക്ക് സുഖമില്ല, വന്നില്ല…',
  Students: 'വിദ്യാർത്ഥികൾ',

  /* ---------------------------------------------------------------- *
   * Time and time zones
   * ---------------------------------------------------------------- */
  Taala: 'താളം',
  'Taala %s': 'താളം %s',
  'Take this one back from %s': '%s-ൽ നിന്ന് ഇത് തിരിച്ചെടുക്കുക',
  'That one phrase, slowly, with the recording at 0.75x.':
    'ആ ഒരു സംഗതി മാത്രം, പതുക്കെ, റെക്കോർഡിംഗ് 0.75x വേഗത്തിൽ വെച്ച്.',
  "That page doesn't exist, or it isn't yours to open.":
    'ആ താൾ ഇല്ല, അല്ലെങ്കിൽ അത് തുറക്കാൻ നിങ്ങൾക്ക് അനുവാദമില്ല.',
  'The gamaka on the second sangati should be slower than it looks written.':
    'രണ്ടാമത്തെ സംഗതിയിലെ ഗമകം എഴുതിക്കാണുന്നതിനെക്കാൾ പതുക്കെ വേണം.',
  'The zone is set automatically the first time they open the site.':
    'അവർ സൈറ്റ് ആദ്യമായി തുറക്കുമ്പോൾ സമയമേഖല സ്വയമേവ നിശ്ചയിക്കപ്പെടും.',
  'Their time zone': 'അവരുടെ സമയമേഖല',
  'their time zone is not set': 'അവരുടെ സമയമേഖല നൽകിയിട്ടില്ല',
  Theory: 'സിദ്ധാന്തം',
  'These are the ones about the song itself — everyone learning it sees them unless you pick people.':
    'ഇവ പാട്ടിനെക്കുറിച്ചുള്ളവയാണ് — ആരെയെങ്കിലും പ്രത്യേകം തിരഞ്ഞെടുക്കാത്തിടത്തോളം ഇത് പഠിക്കുന്ന എല്ലാവരും ഇവ കാണും.',
  'These exist on the song but are not for this student — yet.':
    'ഇവ പാട്ടിലുണ്ട്, പക്ഷേ ഈ വിദ്യാർത്ഥിക്കുള്ളതല്ല — ഇതുവരെ.',
  'These takes exist for this song. Ask your teacher if you need one.':
    'ഈ പാട്ടിന് ഈ റെക്കോർഡിംഗുകൾ ഉണ്ട്. വേണമെങ്കിൽ അധ്യാപകനോട് ചോദിക്കുക.',
  'They were asked to practise:': 'പരിശീലിക്കാൻ പറഞ്ഞത്:',
  'This applies to whatever you record or upload next.':
    'ഇനി റെക്കോർഡ് ചെയ്യുന്നതിനോ അപ്‌ലോഡ് ചെയ്യുന്നതിനോ ഇത് ബാധകമാണ്.',
  'This class is marked %s — %s.': 'ഈ ക്ലാസ് %s എന്ന് അടയാളപ്പെടുത്തിയിരിക്കുന്നു — %s.',
  'This class is marked %s.': 'ഈ ക്ലാസ് %s എന്ന് അടയാളപ്പെടുത്തിയിരിക്കുന്നു.',
  "This is the line pinned to the top of the page next time. Be as specific as you'd want to be reminded.":
    'അടുത്ത തവണ താളിന്റെ മുകളിൽ കാണുന്ന വരി ഇതാണ്. ഓർമ്മിപ്പിക്കപ്പെടാൻ ആഗ്രഹിക്കുന്നത്ര കൃത്യമായി എഴുതുക.',
  "This is what you'll see at the top of this screen next week.":
    'അടുത്ത ആഴ്ച ഈ താളിന്റെ മുകളിൽ കാണുന്നത് ഇതാണ്.',
  'This lesson is logged': 'ഈ ക്ലാസ് രേഖപ്പെടുത്തിയിട്ടുണ്ട്',
  'this song': 'ഈ പാട്ട്',
  'This week': 'ഈ ആഴ്ച',
  'Ticking nobody leaves it with everyone.': 'ആരെയും അടയാളപ്പെടുത്തിയില്ലെങ്കിൽ ഇത് എല്ലാവർക്കുമാകും.',
  Time: 'സമയം',
  "Time is Indian time. The student's own time is recalculated.":
    'സമയം ഇന്ത്യൻ സമയമാണ്. വിദ്യാർത്ഥിയുടെ സ്വന്തം സമയം വീണ്ടും കണക്കാക്കും.',
  'Time zone': 'സമയമേഖല',
  'time zone not set — ask them to open the site once':
    'സമയമേഖല നൽകിയിട്ടില്ല — ഒരു തവണ സൈറ്റ് തുറക്കാൻ അവരോട് പറയുക',
  "Times are set in Indian time and stay fixed there. What each student sees shifts with their own daylight saving, which is why their zone matters more than their offset.":
    'സമയങ്ങൾ ഇന്ത്യൻ സമയത്തിൽ നിശ്ചയിക്കുകയും അവിടെത്തന്നെ ഉറച്ചുനിൽക്കുകയും ചെയ്യുന്നു. ഓരോ വിദ്യാർത്ഥിയും കാണുന്നത് അവരുടെ നാട്ടിലെ ഡേലൈറ്റ് സേവിംഗ് അനുസരിച്ച് മാറും; അതുകൊണ്ടാണ് അവരുടെ സമയവ്യത്യാസത്തെക്കാൾ സമയമേഖല പ്രധാനമാകുന്നത്.',
  "Times on the left are yours, in India. Times on the right are what each student sees on their own clock — recalculated for every class, so daylight saving where they live is already accounted for.":
    'ഇടതുവശത്തെ സമയങ്ങൾ നിങ്ങളുടേതാണ്, ഇന്ത്യയിലേത്. വലതുവശത്തേത് ഓരോ വിദ്യാർത്ഥിയും അവരുടെ ഘടികാരത്തിൽ കാണുന്നതാണ് — ഓരോ ക്ലാസിനും വീണ്ടും കണക്കാക്കുന്നു, അതിനാൽ അവരുടെ നാട്ടിലെ ഡേലൈറ്റ് സേവിംഗ് ഇതിനകം കണക്കിലെടുത്തിട്ടുണ്ട്.',
  "Times shown in Indian time, with each student's own time beside it.":
    'സമയങ്ങൾ ഇന്ത്യൻ സമയത്തിൽ, ഒപ്പം ഓരോ വിദ്യാർത്ഥിയുടെയും സ്വന്തം സമയവും.',
  Title: 'പേര്',
  'Title in Malayalam': 'മലയാളത്തിലുള്ള പേര്',
  'Title, Malayalam, raga, taala or composer…': 'പേര്, മലയാളം, രാഗം, താളം അല്ലെങ്കിൽ രചയിതാവ്…',
  'To practise': 'പരിശീലിക്കാൻ',
  'To practise before next time': 'അടുത്ത തവണയ്ക്ക് മുൻപ് പരിശീലിക്കാൻ',
  today: 'ഇന്ന്',
  never: 'ഒരിക്കലുമില്ല',
  yesterday: 'ഇന്നലെ',
  '%s days ago': '%s ദിവസം മുൻപ്',
  'last month': 'കഴിഞ്ഞ മാസം',
  '%s months ago': '%s മാസം മുൻപ്',
  'Today · %s': 'ഇന്ന് · %s',
  tomorrow: 'നാളെ',
  'Try part of a name, an email address, or where they live.':
    'പേരിന്റെ ഒരു ഭാഗം, ഇമെയിൽ വിലാസം, അല്ലെങ്കിൽ അവർ താമസിക്കുന്ന സ്ഥലം നോക്കുക.',
  "Type or paste Malayalam here. Leave it blank if you'd rather not.":
    'ഇവിടെ മലയാളം എഴുതുകയോ ഒട്ടിക്കുകയോ ചെയ്യാം. വേണ്ടെങ്കിൽ ഒഴിച്ചിടാം.',

  /* ---------------------------------------------------------------- *
   * The rest
   * ---------------------------------------------------------------- */
  Undo: 'പഴയപടിയാക്കുക',
  Ungrouped: 'ഗ്രൂപ്പില്ലാത്തവ',
  'Unlock for %s': '%s-ന് തുറന്നുകൊടുക്കുക',
  upcoming: 'വരാനിരിക്കുന്നത്',
  'Upcoming classes': 'വരാനിരിക്കുന്ന ക്ലാസുകൾ',
  'Update status': 'സ്ഥിതി പുതുക്കുക',
  'updated %s': '%s പുതുക്കി',
  'Upload files': 'ഫയലുകൾ അപ്‌ലോഡ് ചെയ്യുക',
  'Video clip': 'വീഡിയോ',
  'Waiting for approval': 'അനുമതിക്കായി കാത്തിരിക്കുന്നു',
  'was still in progress': 'ഇനിയും നടന്നുകൊണ്ടിരിക്കുകയായിരുന്നു',
  'Watch the gamaka at 0:42 — it should be slower.':
    '0:42-ലെ ഗമകം ശ്രദ്ധിക്കുക — അത് കൂടുതൽ പതുക്കെ വേണം.',
  Week: 'ആഴ്ച',
  'Weekly slots': 'ആഴ്ചയിലെ സമയങ്ങൾ',
  'What you covered': 'നിങ്ങൾ പഠിപ്പിച്ചത്',
  'What you covered in each class with your teacher.':
    'അധ്യാപകനൊപ്പം ഓരോ ക്ലാസിലും പഠിച്ചത്.',
  'WhatsApp number': 'വാട്‌സ്ആപ്പ് നമ്പർ',
  "When someone signs in with Google for the first time, they'll appear here.":
    'ആരെങ്കിലും ആദ്യമായി ഗൂഗിൾ ഉപയോഗിച്ച് പ്രവേശിക്കുമ്പോൾ അവർ ഇവിടെ കാണും.',
  'Where they are': 'അവർ എവിടെയാണ്',
  'Where you are': 'നിങ്ങൾ എവിടെയാണ്',
  'Where you stopped': 'നിങ്ങൾ നിർത്തിയത്',
  'Who can hear it': 'ആർക്ക് കേൾക്കാം',
  'Who can see it': 'ആർക്ക് കാണാം',
  'Who can see it — everyone, unless you say otherwise':
    'ആർക്ക് കാണാം — മറിച്ചു പറയാത്തിടത്തോളം എല്ലാവർക്കും',
  'Who these are for — everyone learning this song':
    'ഇവ ആർക്കുള്ളതാണ് — ഈ പാട്ട് പഠിക്കുന്ന എല്ലാവർക്കും',
  "Why it didn't happen — optional": 'എന്തുകൊണ്ട് നടന്നില്ല — നിർബന്ധമില്ല',
  'With the country code, so the link opens the right chat from anywhere.':
    'രാജ്യത്തിന്റെ കോഡ് ഉൾപ്പെടെ, അങ്ങനെയെങ്കിൽ എവിടെനിന്നും ശരിയായ ചാറ്റ് തുറക്കും.',
  'You already wrote this one up. Edit it under Lessons if anything changed.':
    'ഇത് നിങ്ങൾ ഇതിനകം എഴുതിക്കഴിഞ്ഞു. എന്തെങ്കിലും മാറിയെങ്കിൽ ക്ലാസുകൾക്കു കീഴിൽ തിരുത്താം.',
  'You can also paste an image straight into the note box.':
    'കുറിപ്പിന്റെ കള്ളിയിൽ നേരിട്ട് ഒരു ചിത്രം ഒട്ടിക്കുകയും ചെയ്യാം.',
  'You can change it on any recording afterwards.':
    'ഏതു റെക്കോർഡിംഗിലും ഇത് പിന്നീട് മാറ്റാം.',
  "You're signed in as %s. Your teacher needs to approve this account before your lessons appear. You'll see them here as soon as that happens.":
    'നിങ്ങൾ %s ആയി പ്രവേശിച്ചിരിക്കുന്നു. ക്ലാസുകൾ കാണണമെങ്കിൽ അധ്യാപകൻ ഈ അക്കൗണ്ട് അനുവദിക്കണം. അത് നടക്കുന്ന മാത്രയിൽ അവ ഇവിടെ കാണാം.',
  'Your browser remembers what you leave open.':
    'നിങ്ങൾ തുറന്നിട്ടത് ബ്രൗസർ ഓർത്തുവെക്കും.',
  'Your recordings are private. Only you and your teacher can play them.':
    'നിങ്ങളുടെ റെക്കോർഡിംഗുകൾ സ്വകാര്യമാണ്. നിങ്ങൾക്കും അധ്യാപകനും മാത്രമേ കേൾക്കാനാകൂ.',
  "Your teacher hasn't added a recording for this song yet.":
    'ഈ പാട്ടിന് അധ്യാപകൻ ഇതുവരെ റെക്കോർഡിംഗ് ചേർത്തിട്ടില്ല.',
  "Your teacher hasn't shared any of these with you yet.":
    'ഇവയൊന്നും അധ്യാപകൻ ഇതുവരെ നിങ്ങളുമായി പങ്കുവെച്ചിട്ടില്ല.',
  "Your teacher hasn't shared this one with you yet.":
    'ഇത് അധ്യാപകൻ ഇതുവരെ നിങ്ങളുമായി പങ്കുവെച്ചിട്ടില്ല.',
  'Your time zone': 'നിങ്ങളുടെ സമയമേഖല',
  "Your week in Indian time. Each class also shows the student's own clock underneath. Open a day to change or log its classes.":
    'ഇന്ത്യൻ സമയത്തിൽ നിങ്ങളുടെ ആഴ്ച. ഓരോ ക്ലാസിനും താഴെ വിദ്യാർത്ഥിയുടെ സ്വന്തം സമയവും കാണാം. ഒരു ദിവസത്തെ ക്ലാസുകൾ മാറ്റാനോ രേഖപ്പെടുത്താനോ അത് തുറക്കുക.',
  'zone not set': 'സമയമേഖല നൽകിയിട്ടില്ല',

  /* ---------------------------------------------------------------- *
   * Words the app looks up by value rather than by literal — student
   * status, weekdays, the colour schemes. A key scanner won't find
   * these in the code, so they are listed here by hand.
   * ---------------------------------------------------------------- */
  /* ---------------------------------------------------------------- *
   * The admin's screens
   * ---------------------------------------------------------------- */
  Practices: 'പരിശീലനകേന്ദ്രങ്ങൾ',
  'One project is one teacher and the students they teach. Nothing crosses between them.':
    'ഒരു പ്രോജക്റ്റ് എന്നാൽ ഒരു അധ്യാപകനും അദ്ദേഹം പഠിപ്പിക്കുന്ന വിദ്യാർത്ഥികളും. ഒന്നും പരസ്പരം കടക്കില്ല.',
  'No practices yet': 'ഇതുവരെ പരിശീലനകേന്ദ്രങ്ങളില്ല',
  'Add one below, then add the teacher who runs it.':
    'താഴെ ഒന്ന് ചേർക്കുക, എന്നിട്ട് അത് നടത്തുന്ന അധ്യാപകനെ ചേർക്കുക.',
  'Add a practice': 'ഒരു പരിശീലനകേന്ദ്രം ചേർക്കുക',
  Archived: 'സൂക്ഷിച്ചുവെച്ചവ',
  archived: 'സൂക്ഷിച്ചുവെച്ചു',
  'Nothing is deleted. An archived practice is hidden and cannot be entered, and can be brought back.':
    'ഒന്നും മായ്ക്കപ്പെടുന്നില്ല. സൂക്ഷിച്ചുവെച്ച ഒരു കേന്ദ്രം മറഞ്ഞിരിക്കും, അതിൽ കയറാനാവില്ല, എപ്പോൾ വേണമെങ്കിലും തിരികെ കൊണ്ടുവരാം.',
  'Go in': 'അകത്തു കയറുക',
  Manage: 'ക്രമീകരിക്കുക',
  Leave: 'പുറത്തിറങ്ങുക',
  'no teacher yet': 'ഇതുവരെ അധ്യാപകനില്ല',
  'This practice has no teacher': 'ഈ കേന്ദ്രത്തിന് അധ്യാപകനില്ല',
  'Add their Google address below. Until then only you can see inside it.':
    'താഴെ അവരുടെ ഗൂഗിൾ വിലാസം ചേർക്കുക. അതുവരെ നിങ്ങൾക്ക് മാത്രമേ ഇതിനുള്ളിൽ കാണാനാകൂ.',
  Teachers: 'അധ്യാപകർ',
  'Nobody teaches here yet.': 'ഇവിടെ ഇതുവരെ ആരും പഠിപ്പിക്കുന്നില്ല.',
  'No students here yet.': 'ഇവിടെ ഇതുവരെ വിദ്യാർത്ഥികളില്ല.',
  'Add teacher': 'അധ്യാപകനെ ചേർക്കുക',
  'They are in as soon as they sign in with that address. No second step.':
    'ആ വിലാസം ഉപയോഗിച്ച് പ്രവേശിക്കുന്ന മാത്രയിൽ അവർ അകത്തുണ്ടാകും. രണ്ടാമതൊരു പടിയില്ല.',
  'Take %s out of this practice? Their recordings and lessons stay.':
    '%s-നെ ഈ കേന്ദ്രത്തിൽ നിന്ന് ഒഴിവാക്കണോ? അവരുടെ റെക്കോർഡിംഗുകളും ക്ലാസുകളും നിലനിൽക്കും.',
  'What an admin changed here': 'ഒരു അഡ്മിൻ ഇവിടെ എന്ത് മാറ്റി',
  'an admin': 'ഒരു അഡ്മിൻ',
  'Nothing. A teacher working in their own practice is not recorded here — only an admin acting inside it.':
    'ഒന്നുമില്ല. സ്വന്തം കേന്ദ്രത്തിൽ പണിയെടുക്കുന്ന അധ്യാപകനെ ഇവിടെ രേഖപ്പെടുത്തുന്നില്ല — അതിനുള്ളിൽ പ്രവർത്തിക്കുന്ന അഡ്മിനെ മാത്രം.',
  'Rename, or write a note': 'പേരു മാറ്റുക, അല്ലെങ്കിൽ ഒരു കുറിപ്പ് എഴുതുക',
  'Archive this practice': 'ഈ കേന്ദ്രം സൂക്ഷിച്ചുവെക്കുക',
  'Archive this practice? Nothing is deleted and it can be brought back.':
    'ഈ കേന്ദ്രം സൂക്ഷിച്ചുവെക്കണോ? ഒന്നും മായ്ക്കപ്പെടുന്നില്ല, എപ്പോൾ വേണമെങ്കിലും തിരികെ കൊണ്ടുവരാം.',
  'Bring it back': 'തിരികെ കൊണ്ടുവരിക',
  'Bring this practice back?': 'ഈ കേന്ദ്രം തിരികെ കൊണ്ടുവരണോ?',
  'Archiving hides a practice and stops anyone entering it. Recordings, lessons and students are untouched.':
    'സൂക്ഷിച്ചുവെക്കുന്നത് ഒരു കേന്ദ്രത്തെ മറയ്ക്കുകയും ആരെയും അതിൽ കയറാൻ അനുവദിക്കാതിരിക്കുകയും ചെയ്യുന്നു. റെക്കോർഡിംഗുകളും ക്ലാസുകളും വിദ്യാർത്ഥികളും അതേപടി നിലനിൽക്കും.',
  'Anything you want to remember about this practice':
    'ഈ കേന്ദ്രത്തെക്കുറിച്ച് ഓർത്തുവെക്കാൻ ആഗ്രഹിക്കുന്നതെന്തും',
  'You are inside %s as an admin. Anything you change here is recorded.':
    'നിങ്ങൾ %s-ൽ ഒരു അഡ്മിനായി ഉള്ളിലാണ്. ഇവിടെ മാറ്റുന്നതെല്ലാം രേഖപ്പെടുത്തപ്പെടും.',
  optional: 'നിർബന്ധമില്ല',
  '%s person': '%s പേർ',
  '%s people': '%s പേർ',
  '%s entry': '%s വരി',
  '%s entries': '%s വരികൾ',

  Active: 'സജീവം',
  Paused: 'നിർത്തിവെച്ചു',
  Graduated: 'പഠിച്ചിറങ്ങി',
  Ended: 'അവസാനിപ്പിച്ചു',
  Declined: 'നിരസിച്ചു',
  active: 'സജീവം',
  paused: 'നിർത്തിവെച്ചു',
  graduated: 'പഠിച്ചിറങ്ങി',
  ended: 'അവസാനിപ്പിച്ചു',

  Sunday: 'ഞായർ',
  Monday: 'തിങ്കൾ',
  Tuesday: 'ചൊവ്വ',
  Wednesday: 'ബുധൻ',
  Thursday: 'വ്യാഴം',
  Friday: 'വെള്ളി',
  Saturday: 'ശനി',
  Sun: 'ഞായർ',
  Mon: 'തിങ്കൾ',
  Tue: 'ചൊവ്വ',
  Wed: 'ബുധൻ',
  Thu: 'വ്യാഴം',
  Fri: 'വെള്ളി',
  Sat: 'ശനി',
  Su: 'ഞാ',
  Mo: 'തി',
  Tu: 'ചൊ',
  We: 'ബു',
  Th: 'വ്യാ',
  Fr: 'വെ',
  Sa: 'ശ',

  'Brass & Peacock': 'ഓട്ടും മയിലും',
  'Indigo & Copper': 'നീലയും ചെമ്പും',
  'Palm & Sandalwood': 'പനയും ചന്ദനവും',
  'Kumkum & Slate': 'കുങ്കുമവും സ്ലേറ്റും',
  'Night Practice': 'രാത്രി സാധകം',
  'Match my device': 'എന്റെ ഉപകരണത്തിനൊപ്പം',
  'Always light': 'എപ്പോഴും വെളിച്ചം',
  'Always dark': 'എപ്പോഴും ഇരുട്ട്',
  /* ---- Which hat? ---------------------------------------------- *
     Shown to anyone who is more than one thing here: the admin, a
     teacher of their own practice, a student in another teacher class. */
  'Which hat today?': 'ഇന്ന് ഏത് വേഷം?',
  'You hold more than one standing here. Pick the one you want to work in — you can change it any time from the menu beside your name.':
    'ഇവിടെ നിങ്ങൾക്ക് ഒന്നിലധികം സ്ഥാനങ്ങളുണ്ട്. ഇപ്പോൾ ഏതിലാണോ പ്രവർത്തിക്കേണ്ടത് അത് തിരഞ്ഞെടുക്കുക — പേരിന് അടുത്തുള്ള മെനുവിൽ നിന്ന് എപ്പോൾ വേണമെങ്കിലും മാറ്റാം.',
  'Every practice': 'എല്ലാ ക്ലാസ്സുകളും',
  'Manage every practice, and step into any of them.':
    'എല്ലാ ക്ലാസ്സുകളും കൈകാര്യം ചെയ്യാം, ഏതിലേക്കും കയറാം.',
  'Your students, songs, lessons and schedule.':
    'നിങ്ങളുടെ ശിഷ്യർ, കീർത്തനങ്ങൾ, ക്ലാസ്സുകൾ, സമയക്രമം.',
  'Your songs, your recordings and your teacher’s notes.':
    'നിങ്ങളുടെ കീർത്തനങ്ങൾ, റെക്കോർഡുകൾ, ഗുരുവിന്റെ കുറിപ്പുകൾ.',
  'Where you are now': 'ഇപ്പോൾ ഇവിടെ',
  'Signed in as %s.': '%s ആയി പ്രവേശിച്ചിരിക്കുന്നു.',
  'You': 'നിങ്ങൾ',
  'Switch role': 'വേഷം മാറ്റുക',
  'Admin': 'അഡ്മിൻ',
  'Teacher': 'ഗുരു',
  'Teach it': 'ഇത് പഠിപ്പിക്കുക',

  /* ---- The student's own five tabs ---- */
  'Home': 'ഹോം',
  'Practise now': 'ഇപ്പോൾ സാധകം',
  'With recordings': 'റെക്കോർഡുകളുള്ളവ',
  'Ready to practise.': 'സാധകം ചെയ്യാൻ തയ്യാർ.',
  'The recordings stay here.': 'റെക്കോർഡുകൾ ഇവിടെത്തനെ ഉണ്ടാകും.',
  'No songs yet': 'ഇതുവരെ കീർത്തനങ്ങളില്ല',
  'Your teacher assigns these. They will appear here.': 'ഗുരുവാണ് ഇവ നൽകുന്നത്. അവ ഇവിടെ കാണാം.',
  'What you covered, and where each class stopped.': 'നിങ്ങൾ പഠിച്ചതും, ഓരോ ക്ലാസ്സും നിർത്തിയ ഇടവും.',
  'No classes scheduled': 'ക്ലാസ്സുകളൊന്നും നിശ്ചയിച്ചിട്ടില്ല',
  'Your teacher sets these up. Ask them if you were expecting one.': 'ഗുരുവാണ് ഇവ ക്രമീകരിക്കുന്നത്. ഒന്ന് പ്രതീക്ഷിച്ചിരുന്നെങ്കിൽ അവരോട് ചോദിക്കുക.',
  'This month': 'ഈ മാസം',
  'Your account': 'നിങ്ങളുടെ അക്കൗണ്ട്',
  'The clock your classes are shown on, and how to reach you.': 'ക്ലാസ്സുകൾ കാണിക്കുന്ന സമയവും, നിങ്ങളെ ബന്ധപ്പെടാനുള്ള വിവരങ്ങളും.',
  'in %s days': '%s ദിവസത്തിനകം',
  'next week': 'അടുത്ത ആഴ്ച',
  'in %s weeks': '%s ആഴ്ചയ്ക്കുള്ളിൽ',
  'nothing scheduled': 'ഒന്നും നിശ്ചയിച്ചിട്ടില്ല',
  'Slow any recording down without changing the pitch, and loop the phrase you are working on.': 'ശ്രുതി മാറാതെ ഏത് റെക്കോർഡിനെയും പൊതുക്കാം, സാധകം ചെയ്യുന്ന ഭാഗം ആവർത്തിക്കാം.',
  'Your name and photo come from the Google account you sign in with. Colours and language are in the menu beside your name.': 'പേരും ഫോട്ടോയും നിങ്ങൾ പ്രവേശിക്കുന്ന Google അക്കൗണ്ടിൽ നിന്നാണ്. നിറങ്ങളും ഭാഷയും പേരിന് അടുത്തുള്ള മെനുവിലുണ്ട്.',
  'In your own time — set your time zone in Settings so these are right.': 'നിങ്ങളുടെ സമയത്തിൽ — ഇവ ശരിയാകാൻ ക്രമീകരണങ്ങളിൽ സമയ മേഖല ക്രമീകരിക്കുക.',
  'Times are shown on your clock (%s) and on the teacher’s. Change yours in Settings.': 'സമയങ്ങൾ നിങ്ങളുടെ (%s) ക്ലോക്കിലും ഗുരുവിന്റേതിലും കാണിക്കുന്നു. മാറ്റം ക്രമീകരണങ്ങളിൽ.',
  'Your time zone is not set, so these are shown on the teacher’s clock. Set it in Settings.': 'നിങ്ങളുടെ സമയ മേഖല ക്രമീകരിച്ചിട്ടില്ല, അതുകൊണ്ട് ഇവ ഗുരുവിന്റേ ക്ലോക്കിലാണ്. ക്രമീകരണങ്ങളിൽ ക്രമീകരിക്കുക.',

  /* ---- When a song was started, and finished ---- */
  'Started': 'തുടങ്ങിയത്',
  'started %s': '%s തുടങ്ങി',
  'Save dates': 'തീയതികൾ സേവ് ചെയ്യുക',
  'not recorded': 'രേഖപ്പെടുത്തിയിട്ടില്ല',
  'learning': 'പഠിക്കുന്നു',
  'Clear the finish date to put it back in progress.': 'തീർന്ന തീയതി ഒഴിവാക്കിയാൽ വീണ്ടും പഠിക്കുന്നതായി മാറും.',

  /* ---- Paging through the lesson history ---- */
  '← Newer': '← പുതിയത്',
  'Older →': 'പഴയത് →',
  'Page %1$s of %2$s': '%2$s-ൽ %1$s-ാം പേജ്',
  'More lessons': 'കൂടുതൽ ക്ലാസ്സുകൾ',
};
