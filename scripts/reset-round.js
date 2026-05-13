/**
 * reset-round.js — Reset a completed lottery round back to 'closed' for retesting.
 *
 * What it does (in one transaction):
 *  1. Find all winning tickets for the round
 *  2. Reverse score / lotteryWinCount / lotteryTotalWinnings for each winner
 *  3. Reset ALL tickets for the round (isWinner=FALSE, isPrizeClaimed=FALSE, prizeAmount=0)
 *  4. Delete winner-type notifications tied to this round
 *  5. Clear result fields on lottery_rounds and set status='closed'
 *
 * Usage:
 *   node scripts/reset-round.js 2026-05-02
 *   DRY_RUN=1 node scripts/reset-round.js 2026-05-02   ← preview only, no writes
 */
require('dotenv').config();
const db = require('../db');

const roundId = process.argv[2];
const DRY_RUN = process.env.DRY_RUN === '1';

if (!roundId) {
    console.error('Usage: node scripts/reset-round.js <roundId>');
    process.exit(1);
}

(async () => {
    console.log(`\n🔄 Reset round: ${roundId}${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

    // --- 1. Read round
    const [[round]] = await db.query('SELECT * FROM lottery_rounds WHERE roundId=?', [roundId]);
    if (!round) { console.error('❌ Round not found'); process.exit(1); }
    console.log(`Round status: ${round.status} | last2: ${round.last2} | last3_back: ${round.last3_back}`);

    if (!['completed', 'confirmed'].includes(round.status)) {
        console.error(`⚠️  Status is '${round.status}' — only 'completed' or 'confirmed' rounds should be reset this way.`);
        process.exit(1);
    }

    // --- 2. Find winning tickets (to reverse scores)
    const [winners] = await db.query(
        `SELECT ticketId, lineUserId, ticketType, prizeAmount FROM lottery_tickets
         WHERE roundId=? AND isWinner=TRUE`,
        [roundId]
    );
    console.log(`\nWinning tickets: ${winners.length}`);
    winners.forEach(w => console.log(`  ${w.ticketId} | ${w.lineUserId.slice(0,8)}… | ${w.ticketType} | prize=${w.prizeAmount}`));

    const [allTickets] = await db.query(
        'SELECT COUNT(*) AS cnt FROM lottery_tickets WHERE roundId=?', [roundId]
    );
    console.log(`Total tickets for round: ${allTickets[0].cnt}`);

    if (DRY_RUN) {
        console.log('\n[DRY RUN] No changes made. Remove DRY_RUN=1 to execute.');
        process.exit(0);
    }

    // --- 3. Execute in transaction
    const conn = await db.getClient();
    try {
        await conn.beginTransaction();

        // Reverse scores for each winner
        for (const w of winners) {
            const prize = Number(w.prizeAmount) || 0;
            if (prize > 0) {
                await conn.query(
                    `UPDATE users SET
                        totalScore = GREATEST(0, totalScore - ?),
                        lotteryWinCount = GREATEST(0, lotteryWinCount - 1),
                        lotteryTotalWinnings = GREATEST(0, lotteryTotalWinnings - ?)
                     WHERE lineUserId=?`,
                    [prize, prize, w.lineUserId]
                );
                console.log(`  ↩ Reversed ${prize} pts from ${w.lineUserId.slice(0,8)}…`);
            }
        }

        // Reset all tickets for this round
        const [ticketReset] = await conn.query(
            `UPDATE lottery_tickets
             SET isWinner=FALSE, isPrizeClaimed=FALSE, prizeAmount=0
             WHERE roundId=?`,
            [roundId]
        );
        console.log(`\n✅ Reset ${ticketReset.affectedRows} tickets`);

        // Delete winner notifications for this round
        const [notifDel] = await conn.query(
            `DELETE FROM notifications WHERE type IN ('lottery_win','lottery_admin_alert') AND relatedItemId=?`,
            [roundId]
        );
        console.log(`🗑  Deleted ${notifDel.affectedRows} notifications`);

        // Clear round result & set status='closed'
        await conn.query(
            `UPDATE lottery_rounds
             SET status='closed', source='manual', confirmedBy=NULL,
                 first_prize=NULL, last2=NULL, last3_back=NULL, last3_back2=NULL,
                 last3_front=NULL, last3_front2=NULL,
                 prizeTwoSnapshot=NULL, prizeThreeSnapshot=NULL,
                 priceTwoSnapshot=NULL, priceThreeSnapshot=NULL,
                 prizeSixSnapshot=NULL, priceSixSnapshot=NULL
             WHERE roundId=?`,
            [roundId]
        );
        console.log(`🔄 Round ${roundId} reset to status='closed'`);

        await conn.commit();
        console.log('\n✅ Transaction committed. Round is ready to retest.\n');
    } catch (err) {
        await conn.rollback();
        console.error('❌ Transaction rolled back:', err.message);
        process.exit(1);
    } finally {
        conn.release();
    }

    process.exit(0);
})();
