/**
 * 閉じていても届く通知を送る（Google Apps Script・無料枠）
 * 設定：
 *  1. 「プロジェクトの設定」→「スクリプト プロパティ」に SERVICE_ACCOUNT を追加し、
 *     Firebaseで作った秘密鍵JSONの中身を丸ごと貼る（このファイルには書かない）
 *  2. 関数 setup を1回実行する（5分ごとの自動実行が登録される）
 */
const PROJECT_ID = 'school-site-475fc';
const ADMIN_UID = 'Z4YHNqiKySV3KLkHIjtDaj36WUa2';
const SITE_BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';

function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  tick();
}

function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const token = accessToken_();
    let cache;
    const people = () => cache || (cache = {
      tokens: listAll_(token, 'pushTokens'),
      members: listAll_(token, 'members'),
      stopped: listAll_(token, 'suspended').map(d => d.id)
    });
    const forClass = target => people().members
      .filter(m => !people().stopped.includes(m.id) && (target === '両方' || m.data.classId === target))
      .map(m => m.id);

    // 新しい投稿
    pending_(token, 'posts').forEach(p => {
      markPushed_(token, p);
      send_(token, people().tokens, forClass(p.data.classTarget), '新しい投稿（' + p.data.category + '）', p.data.title, p.id);
    });
    // 時刻が来たリマインダー
    pending_(token, 'announcements').forEach(a => {
      if (new Date(a.data.publishAt).getTime() > Date.now()) return;
      patch_(token, a.name, { published: { booleanValue: true }, pushed: { booleanValue: true } });
      send_(token, people().tokens, forClass(a.data.classTarget), 'リマインダー：' + a.data.title, a.data.body || '', '');
    });
    // 承認された人
    pending_(token, 'members').forEach(m => {
      markPushed_(token, m);
      send_(token, people().tokens, [m.id], '承認されました', '共有サイトを利用できるようになりました', '');
    });
    // 管理者あて（まとめて1件）
    const inbox = pending_(token, 'adminInbox');
    if (inbox.length) {
      inbox.forEach(n => markPushed_(token, n));
      send_(token, people().tokens, [ADMIN_UID], '共有サイト', '新しい通知が' + inbox.length + '件あります', '');
    }
  } finally {
    lock.releaseLock();
  }
}

function accessToken_() {
  const cached = CacheService.getScriptCache().get('token');
  if (cached) return cached;
  const key = JSON.parse(PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT'));
  const enc = o => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const body = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: key.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging'
  });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(body, key.private_key)).replace(/=+$/, '');
  const res = JSON.parse(UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: body + '.' + sig }
  }).getContentText());
  CacheService.getScriptCache().put('token', res.access_token, 3000);
  return res.access_token;
}

function api_(token, url, method, body) {
  const options = { method: method || 'get', headers: { Authorization: 'Bearer ' + token }, contentType: 'application/json', muteHttpExceptions: true };
  if (body) options.payload = JSON.stringify(body);
  const res = UrlFetchApp.fetch(url, options);
  if (res.getResponseCode() >= 300) throw new Error(res.getResponseCode() + ' ' + res.getContentText());
  return JSON.parse(res.getContentText() || '{}');
}

function parse_(d) {
  const data = {};
  Object.keys(d.fields || {}).forEach(k => { const v = d.fields[k]; data[k] = v[Object.keys(v)[0]]; });
  return { name: d.name, id: d.name.split('/').pop(), data: data };
}

function pending_(token, col) {
  return api_(token, SITE_BASE + ':runQuery', 'post', { structuredQuery: {
    from: [{ collectionId: col }],
    where: { fieldFilter: { field: { fieldPath: 'pushed' }, op: 'EQUAL', value: { booleanValue: false } } },
    limit: 100
  } }).filter(r => r.document).map(r => parse_(r.document));
}

function listAll_(token, col) {
  let out = [], page = '';
  do {
    const res = api_(token, SITE_BASE + '/' + col + '?pageSize=300' + (page ? '&pageToken=' + page : ''));
    out = out.concat((res.documents || []).map(parse_));
    page = res.nextPageToken;
  } while (page);
  return out;
}

function patch_(token, name, fields) {
  const mask = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&');
  api_(token, 'https://firestore.googleapis.com/v1/' + name + '?' + mask + '&currentDocument.exists=true', 'patch', { fields: fields });
}
function markPushed_(token, item) { patch_(token, item.name, { pushed: { booleanValue: true } }); }

function send_(token, tokens, uids, title, body, postId) {
  const targets = tokens.filter(t => uids.includes(t.data.uid));
  if (!targets.length) return;
  const responses = UrlFetchApp.fetchAll(targets.map(t => ({
    url: 'https://fcm.googleapis.com/v1/projects/' + PROJECT_ID + '/messages:send',
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ message: { token: t.id, data: { title: title, body: String(body).slice(0, 120), postId: postId }, webpush: { headers: { Urgency: 'high' } } } })
  })));
  // 使えなくなった端末は削除する
  responses.forEach((r, i) => {
    if (r.getResponseCode() === 404) api_(token, 'https://firestore.googleapis.com/v1/' + targets[i].name, 'delete');
  });
}
