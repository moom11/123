-- =============================================================================
-- 008 expose the manager's comment to the purchasing rep
--
-- When a branch manager cuts 60 L to 40 L they usually say why. The rep needs
-- that reason to do their job — it is the difference between "the system gave
-- me a smaller number" and "the manager decided 40 L is enough". The comment
-- is already stored; this simply lets the buyer view read it.
--
-- Nothing else about the view changes: unapproved requests remain invisible,
-- and the requested quantity remains hidden.
-- =============================================================================

DROP VIEW IF EXISTS buyer_purchase_requests;

CREATE VIEW buyer_purchase_requests AS
SELECT
  pr.id,
  pr.request_number,
  pr.branch_id,
  pr.department,
  pr.status,
  pr.priority,
  pr.needed_by,
  pr.notes,
  pr.manager_comment,
  pr.approved_at,
  pr.buyer_user_id,
  pr.purchased_at,
  pr.in_transit_at,
  pr.delivered_at,
  pr.received_at,
  pr.created_at,
  pr.updated_at
FROM purchase_requests pr
WHERE pr.status IN ('approved','sent_to_buyer','purchasing','purchased',
                    'in_transit','delivered','received','closed');
