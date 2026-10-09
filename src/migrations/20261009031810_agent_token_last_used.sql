-- 20261009031810: agent token last used
--
-- When each agent token was last used to authenticate, so Settings can show
-- "Last used 2h ago" and stale tokens stand out. NULL means never used.
-- The bearer-auth middleware refreshes it at most once an hour per token, so
-- agent traffic does not turn every read into a write. Additive and
-- nullable: existing rows read as never used until their next request.
ALTER TABLE agent_tokens ADD COLUMN last_used_at TEXT;
