import { db, verify } from './_lib.js';
const PRIZES = [0, 1, 20, 40, 60, 100]; // must match wheel segments in index.html
const SPIN_COST = 30, MIN_WITHDRAW = 5000, REF_BONUS = 100;
const upd = (id, o) => db.from('users').update(o).eq('id', id);

export default async function handler(req, res) {
  const u = verify(req.body?.initData || '');
  if (!u) return res.status(401).json({ error: 'auth' });
  const { action, taskId, address } = req.body;
  const today = new Date().toISOString().slice(0, 10);

  let { data: me } = await db.from('users').select('*').eq('id', u.id).maybeSingle();
  if (!me) { // new user (+ referral from ?startapp=REFERRER_ID)
    const ref = Number(u.start) && Number(u.start) !== u.id ? Number(u.start) : null;
    ({ data: me } = await db.from('users').insert({ id: u.id, name: u.first_name, referred_by: ref }).select().single());
    if (ref) {
      const { data: r } = await db.from('users').select('points,refs').eq('id', ref).maybeSingle();
      if (r) await upd(ref, { points: r.points + REF_BONUS, refs: r.refs + 1 });
    }
  }
  if (me.last_day !== today) { // 1 free spin every day
    me.spins += 1; me.last_day = today;
    await upd(u.id, { spins: me.spins, last_day: today });
  }

  let extra = {};
  if (action === 'spin') {
    if (me.spins > 0) me.spins--;
    else if (me.points >= SPIN_COST) me.points -= SPIN_COST;
    else return res.json({ error: 'No spins left' });
    const i = Math.floor(Math.random() * PRIZES.length);
    me.points += PRIZES[i];
    await upd(u.id, { spins: me.spins, points: me.points });
    extra = { prize: i };
  }
  if (action === 'task') {
    const { data: t } = await db.from('tasks').select('*').eq('id', taskId).single();
    if (!t) return res.json({ error: 'No task' });
    if (t.chat) { // real check: is user a member of the channel? (bot must be admin there)
      const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(t.chat)}&user_id=${u.id}`);
      const j = await r.json();
      if (!j.ok || ['left', 'kicked'].includes(j.result.status)) return res.json({ error: 'Join first, then press Verify' });
    }
    const { error } = await db.from('done_tasks').insert({ user_id: u.id, task_id: t.id });
    if (error) return res.json({ error: 'Already done' });
    me.points += t.reward; await upd(u.id, { points: me.points });
  }
  if (action === 'withdraw') {
    if (me.points < MIN_WITHDRAW) return res.json({ error: `Minimum ${MIN_WITHDRAW} points` });
    if (!address || address.length < 20) return res.json({ error: 'Invalid address' });
    await db.from('withdrawals').insert({ user_id: u.id, points: me.points, address });
    me.points = 0; await upd(u.id, { points: 0 });
  }

  const [t, d, w, lb] = await Promise.all([
    db.from('tasks').select('*').order('id'),
    db.from('done_tasks').select('task_id').eq('user_id', u.id),
    db.from('withdrawals').select('*').eq('user_id', u.id).order('id', { ascending: false }),
    db.from('users').select('name,points').order('points', { ascending: false }).limit(10),
  ]);
  res.json({ me, tasks: t.data, done: d.data.map(x => x.task_id), withdrawals: w.data, top: lb.data, ...extra });
}
