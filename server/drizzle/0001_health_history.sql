-- Health history: services that are not actively monitored (or still waiting for their first
-- heartbeat) start with an open NO_DATA period, so the 7-day chart doesn't show them as healthy.
INSERT INTO `health_events` (`id`, `service_id`, `event_type`, `started_at`)
SELECT lower(hex(randomblob(8))), `id`, 'NO_DATA', CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM `services`
WHERE `health_enabled` = 0 OR `status` != 'ACTIVE' OR `health_status` = 'UNKNOWN';
