-- A recording gets a few lines of description beyond its short name, so the
-- teacher can say what a take actually demonstrates — "second sangati, slowly,
-- with the gamaka held longer than written".
ALTER TABLE recordings ADD COLUMN description TEXT;

-- A note gets a heading, so a long list of notes can be scanned rather than read.
ALTER TABLE notes ADD COLUMN title TEXT;
