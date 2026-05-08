#!/usr/bin/env node

const baseUrl = (process.env.SMOKE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const adminId = process.env.SMOKE_ADMIN_ID;
const userId = process.env.SMOKE_USER_ID || adminId;
const shouldBuy = process.env.SMOKE_BUY === '1';
const shouldDream = process.env.SMOKE_DREAM === '1';
const shouldDreamInterpret = process.env.SMOKE_DREAM_INTERPRET === '1';
const shouldCleanup = process.env.SMOKE_CLEANUP === '1';

function nextFutureDate() {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

const roundDate = process.env.SMOKE_ROUND_DATE || nextFutureDate();
const dreamId = (process.env.SMOKE_DREAM_ID || `SMK${Date.now().toString(36).toUpperCase()}`).slice(0, 20);

function maskId(value) {
  if (!value) return '';
  return `${String(value).slice(0, 6)}...${String(value).slice(-4)}`;
}

function flattenDreamItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  return Object.values(data).flatMap(group => Array.isArray(group?.items) ? group.items : []);
}

async function callApi(endpoint, payload = {}, method = 'GET') {
  const url = new URL(baseUrl + endpoint);
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };

  if (adminId && !payload.requesterId) payload.requesterId = adminId;

  if (method === 'GET') {
    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });
  } else {
    options.body = JSON.stringify(payload);
  }

  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === 'error') {
    throw new Error(`${method} ${endpoint} failed: ${body.message || response.statusText}`);
  }
  return body.data;
}

async function createTestRound() {
  try {
    await callApi('/api/admin/lottery/rounds', {
      requesterId: adminId,
      drawDate: roundDate,
      isTest: true
    }, 'POST');
    console.log(`created test round ${roundDate}`);
    return true;
  } catch (err) {
    if (/already exists|duplicate|Duplicate|ER_DUP_ENTRY/i.test(err.message) || err.message.includes('มีงวดนี้แล้ว')) {
      console.log(`test round ${roundDate} already exists; continuing`);
      return false;
    }
    if (/มีงวดนี้แล้ว|duplicate|Duplicate/i.test(err.message)) {
      console.log(`test round ${roundDate} already exists; continuing`);
      return false;
    }
    throw err;
  }
}

async function getCorrectQuizAnswerId() {
  const question = await callApi('/api/lottery/quiz-question', { lineUserId: userId });
  for (const selectedOption of ['A', 'B', 'C', 'D']) {
    const answer = await callApi('/api/lottery/answer-quiz', {
      lineUserId: userId,
      questionId: question.questionId,
      selectedOption
    }, 'POST');
    if (answer.isCorrect) return answer.quizAnswerId;
  }
  throw new Error('Could not obtain a correct lottery quiz answer');
}

async function upsertDreamSmokeItem() {
  const payload = {
    requesterId: adminId,
    dreamId,
    category: 'ppe',
    itemName: 'Smoke Test Symbol',
    itemIcon: 'T',
    number2d: '42',
    number3d: '142',
    safetyFact: 'Smoke test item for pre-deploy verification.',
    promptHint: 'Return a concise safety reminder.'
  };

  try {
    await callApi('/api/admin/lottery/dream-items', payload, 'POST');
    console.log(`created dream item ${dreamId}`);
  } catch (err) {
    if (!/duplicate|Duplicate|ER_DUP_ENTRY/i.test(err.message) && !err.message.includes('มีอยู่แล้ว')) throw err;
    await callApi(`/api/admin/lottery/dream-items/${encodeURIComponent(dreamId)}`, payload, 'PUT');
    console.log(`updated existing dream item ${dreamId}`);
  }
}

async function runDreamChecks() {
  await upsertDreamSmokeItem();

  const adminItems = await callApi('/api/admin/lottery/dream-items', { requesterId: adminId });
  const adminMatch = Array.isArray(adminItems) && adminItems.some(item => item.dreamId === dreamId);
  if (!adminMatch) throw new Error(`Admin dream item list did not include ${dreamId}`);
  console.log('admin dream-items OK');

  const publicItems = flattenDreamItems(await callApi('/api/lottery/dream-items', { lineUserId: userId }));
  const publicMatch = publicItems.some(item => item.dreamId === dreamId || item.itemId === dreamId);
  if (!publicMatch) throw new Error(`Public dream item list did not include ${dreamId}`);
  console.log('public dream-items OK');

  await callApi('/api/admin/lottery/dream-logs', { requesterId: adminId });
  console.log('admin dream logs OK');

  if (shouldDreamInterpret) {
    const result = await callApi('/api/lottery/dream-interpret', {
      requesterId: adminId,
      lineUserId: userId,
      itemId: dreamId,
      dreamText: 'pre-deploy smoke test'
    }, 'POST');

    if (!/^\d{2}$/.test(result.number2d || '') || !/^\d{3}$/.test(result.number3d || '')) {
      throw new Error(`Dream interpret returned invalid numbers: ${JSON.stringify(result)}`);
    }
    console.log('dream interpret OK');

    await callApi('/api/lottery/dream-today', {
      requesterId: adminId,
      lineUserId: userId
    });
    console.log('dream-today OK');
  } else {
    console.log('skipped dream interpret; set SMOKE_DREAM_INTERPRET=1 to exercise AI/fallback generation');
  }

  if (shouldCleanup) {
    await callApi(`/api/admin/lottery/dream-items/${encodeURIComponent(dreamId)}`, {
      requesterId: adminId
    }, 'DELETE');
    await callApi(`/api/admin/lottery/dream-logs/user/${encodeURIComponent(userId)}`, {
      requesterId: adminId
    }, 'DELETE');
    console.log('dream cleanup OK');
  } else {
    console.log('skipped dream cleanup; set SMOKE_CLEANUP=1 to soft-delete the test symbol and reset today log');
  }
}

async function run() {
  if (!adminId) {
    throw new Error('SMOKE_ADMIN_ID is required. It must be a lineUserId in admins.');
  }

  console.log(`Safety Lottery smoke check against ${baseUrl}`);
  console.log(`round=${roundDate} admin=${maskId(adminId)} user=${maskId(userId)}`);

  await callApi('/api/admin/lottery/dashboard', { requesterId: adminId });
  await callApi('/api/admin/lottery/settings', { requesterId: adminId });
  await createTestRound();

  const currentRound = await callApi('/api/lottery/current-round', {
    lineUserId: userId,
    forceRoundId: roundDate
  });
  if (currentRound.roundId !== roundDate) {
    throw new Error(`Expected current test round ${roundDate}, got ${currentRound.roundId || 'none'}`);
  }
  console.log('current-round test visibility OK');

  await callApi('/api/admin/lottery/monitor', { requesterId: adminId, roundId: roundDate });
  console.log('admin monitor OK');

  if (shouldBuy) {
    const quizAnswerId = await getCorrectQuizAnswerId();
    await callApi('/api/lottery/buy-ticket', {
      lineUserId: userId,
      roundId: roundDate,
      ticketType: 'two',
      number: '42',
      quizAnswerId
    }, 'POST');
    console.log('test ticket purchase OK');

    await callApi(`/api/admin/lottery/rounds/${encodeURIComponent(roundDate)}/reset-tickets`, {
      requesterId: adminId
    }, 'POST');
    console.log('reset tickets OK');
  } else {
    console.log('skipped ticket purchase; set SMOKE_BUY=1 to exercise buy/reset');
  }

  if (shouldDream) {
    await runDreamChecks();
  } else {
    console.log('skipped Johnny dream checks; set SMOKE_DREAM=1 to exercise dream admin/user endpoints');
  }

  if (shouldCleanup) {
    await callApi(`/api/admin/lottery/rounds/${encodeURIComponent(roundDate)}`, {
      requesterId: adminId
    }, 'DELETE');
    console.log('cleanup delete round OK');
  } else {
    console.log('skipped cleanup; set SMOKE_CLEANUP=1 to delete the test round');
  }
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
