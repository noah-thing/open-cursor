-- One row per install: a hash of the random ID the app makes on first launch, nothing else about the person.
CREATE TABLE installs (
	hash TEXT PRIMARY KEY,
	first_day TEXT NOT NULL,
	last_day TEXT NOT NULL,
	os TEXT NOT NULL,
	arch TEXT NOT NULL,
	version TEXT NOT NULL
);
CREATE INDEX installs_first_day ON installs (first_day);
CREATE INDEX installs_last_day ON installs (last_day);

-- Which installs were opened on which day, for daily, weekly and monthly active counts.
CREATE TABLE active (
	day TEXT NOT NULL,
	hash TEXT NOT NULL,
	PRIMARY KEY (day, hash)
);
