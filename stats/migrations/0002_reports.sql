-- Problem reports sent from the app's Report a Problem form. Only what the person saw and chose to send:
-- their description, an optional way to reach them, and the app facts the form lists. No IP addresses.
CREATE TABLE reports (
	id TEXT PRIMARY KEY,
	time INTEGER NOT NULL,
	version TEXT NOT NULL,
	os TEXT NOT NULL,
	arch TEXT NOT NULL,
	model TEXT,
	mode TEXT,
	folder INTEGER,
	error TEXT,
	message TEXT NOT NULL,
	contact TEXT,
	sig TEXT,
	status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX reports_time ON reports (time);

-- How many reports one install sent in one hour, to keep a stuck loop or a spammer from flooding the list.
CREATE TABLE report_limits (
	hash TEXT NOT NULL,
	hour TEXT NOT NULL,
	n INTEGER NOT NULL,
	PRIMARY KEY (hash, hour)
);
