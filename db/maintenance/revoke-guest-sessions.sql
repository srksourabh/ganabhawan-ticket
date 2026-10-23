-- Incident remediation: guest-checkout account takeover (fix: "fix(auth): prevent guest checkout account takeover").
--
-- Before the fix, POST /api/auth/guest issued an ordinary ACCOUNT session (valid 12 hours) for
-- whatever email was typed. Deploying the fix stops new ones but does not end sessions already
-- issued. Run this ONCE, right after the fix is deployed, to end every session that the guest
-- checkout created. Not applied by db:migrate. Touches only the sessions table.
--
-- How they are found: the guest checkout inserted the session and its 'auth.guest' audit row in
-- the same transaction, so both carry the same now() timestamp. Sign-ins by code, password or
-- Google never write 'auth.guest', so they are not matched. Guest checkout sessions created by
-- the fixed code are matched too; ending them only asks a guest who is mid-checkout to enter
-- their details again (a payment already made is still settled by the webhook).
--
-- Preview first (counts only):
--   SELECT count(*) FROM sessions s JOIN audit_events a
--     ON a.action='auth.guest' AND a.actor_id=s.user_id AND a.created_at=s.created_at;
BEGIN;
DELETE FROM sessions s
 USING audit_events a
 WHERE a.action = 'auth.guest'
   AND a.actor_id = s.user_id
   AND a.created_at = s.created_at;
COMMIT;
