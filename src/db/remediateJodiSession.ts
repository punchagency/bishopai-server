import 'dotenv/config';
import { pool } from './pool';
import { processConversation } from '../session/process';

async function remediateRealSessions() {
  console.log('--- Starting Precise Data Remediation for Jodi Hess & Steve Broderick ---');

  const STEVE_CONV_ID = 'e60ffcfd-feff-41e8-9d09-5e45a956a7f1';
  const JODI_CONV_ID = 'aa2cb392-bdbf-4b8e-95a8-22d4d4f76ded';

  const STEVE_APPT_ID = 'd966e88e-2ddc-4cb9-b13d-92c7067ebb60';
  const STEVE_CLIENT_ID = '2ffb244f-1c37-4f85-8890-cea6f27a2ff5';

  const JODI_APPT_ID = '6939e355-3c2f-4cf1-9e44-03a4fef361b1';
  const JODI_CLIENT_ID = '6e4828b2-77fd-42f3-b7af-3d385dc8cd73';

  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    // 1. Delete prior temporary remediation child conversations & bad draft notes
    await db.query(`DELETE FROM conversations WHERE parent_conversation_id IS NOT NULL`);
    await db.query(`DELETE FROM appointment_sheets WHERE appointment_id IN ($1, $2) AND status <> 'approved'`, [JODI_APPT_ID, STEVE_APPT_ID]);
    await db.query(`DELETE FROM protocols WHERE appointment_id IN ($1, $2) AND status <> 'approved'`, [JODI_APPT_ID, STEVE_APPT_ID]);

    // 2. Assign Steve's conversation (19:27-20:08) to Steve Broderick
    await db.query(
      `UPDATE conversations
          SET appointment_id = $2,
              client_id = $3,
              correlation_status = 'matched',
              extraction_status = 'pending',
              extraction_leased_at = NULL,
              extraction_error = NULL
        WHERE id = $1`,
      [STEVE_CONV_ID, STEVE_APPT_ID, STEVE_CLIENT_ID],
    );
    console.log(`Re-assigned conversation ${STEVE_CONV_ID} (19:27-20:08) to Steve Broderick.`);

    // 3. Assign Jodi's REAL recording (20:36-21:36) to Jodi Hess's appointment
    await db.query(
      `UPDATE conversations
          SET appointment_id = $2,
              client_id = $3,
              correlation_status = 'matched',
              extraction_status = 'pending',
              extraction_leased_at = NULL,
              extraction_error = NULL
        WHERE id = $1`,
      [JODI_CONV_ID, JODI_APPT_ID, JODI_CLIENT_ID],
    );
    console.log(`Assigned REAL recording ${JODI_CONV_ID} (20:36-21:36) to Jodi Hess.`);

    await db.query('COMMIT');
    console.log('Database assignments committed successfully.');

    // 4. Process extractions
    console.log(`Processing extraction for Steve Broderick (${STEVE_CONV_ID})...`);
    await processConversation(STEVE_CONV_ID);

    console.log(`Processing extraction for Jodi Hess (${JODI_CONV_ID})...`);
    await processConversation(JODI_CONV_ID);

    console.log('--- Real Remediation Completed Successfully ---');
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Remediation failed:', err);
  } finally {
    db.release();
    process.exit(0);
  }
}

void remediateRealSessions();
