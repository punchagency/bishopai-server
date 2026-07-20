-- Sessions left half-approved by the per-document model.
--
-- A sheet and a protocol hold the same note and are now approved together, but
-- existing rows were approved one at a time. That leaves sessions where one side
-- is approved (its documents published) and the other is a stale draft — the
-- exact divergence the session model exists to prevent, frozen into the data.
--
-- Copy the approved side's note onto the lagging side and approve it. The
-- approved side wins because it is the one whose documents actually went out;
-- the draft's content was never delivered anywhere.

-- Protocol lagging behind an approved sheet.
UPDATE protocols p
   SET content_json = s.content_json,
       status       = 'approved'
  FROM appointment_sheets s
 WHERE s.appointment_id = p.appointment_id
   AND s.status = 'approved'
   AND p.status <> 'approved';

-- Sheet lagging behind an approved protocol.
UPDATE appointment_sheets s
   SET content_json = p.content_json,
       status       = 'approved'
  FROM protocols p
 WHERE p.appointment_id = s.appointment_id
   AND p.status = 'approved'
   AND s.status <> 'approved';
