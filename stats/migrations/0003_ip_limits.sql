-- Per network limits for pings and reports. The key is a hash of the IP address salted with the day
-- and a server secret, so the address itself is never stored and the hash means nothing the next day.
CREATE TABLE ip_limits (
	kind TEXT NOT NULL,
	period TEXT NOT NULL,
	hash TEXT NOT NULL,
	n INTEGER NOT NULL,
	PRIMARY KEY (kind, period, hash)
);
