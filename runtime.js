/* نظام احتواء — طبقة التشغيل المشتركة: الدخول، الصلاحيات، وربط الصفحات بقاعدة Firebase.
   تعرّف window.claude.use(...) بنفس الواجهة التي كتبت بها الصفحات، فلا تحتاج الصفحات تعديلاً في منطقها. */
(function () {
  'use strict';
  var CONFIG = {
    apiKey: 'AIzaSyCT0ua6Eu9pg5Uzx-zhSGzNbAagbGmX7jE',
    authDomain: 'ihtiwa-system.firebaseapp.com',
    projectId: 'ihtiwa-system',
    storageBucket: 'ihtiwa-system.firebasestorage.app',
    messagingSenderId: '83385948856',
    appId: '1:83385948856:web:cac15aa484c54604d1b24d'
  };
  var OWNER = 'sarshoud@gmail.com';
  var V = '10.12.2';
  var meta = function (n) { var m = document.querySelector('meta[name="' + n + '"]'); return m ? m.content : ''; };
  var APP = meta('ihtiwa-app') || 'plan';
  var ADMIN_ONLY = meta('ihtiwa-access') === 'admin';
  // collections a leader may only read doc-by-doc (one per committee)
  var SCOPED = { com_rosters: true };

  var resolveReady; var ready = new Promise(function (r) { resolveReady = r; });
  var FB = null; // { app, auth, db, fs, au }
  var IHT = window.IHT = { role: null, email: '', committees: [], names: [], app: APP, ready: ready };

  // ---------- Firestore value encoding (Firestore cannot hold arrays inside arrays)
  function hasNested(v, inArr) {
    if (Array.isArray(v)) { if (inArr) return true; for (var i = 0; i < v.length; i++) if (hasNested(v[i], true)) return true; return false; }
    if (v && typeof v === 'object') { for (var k in v) if (hasNested(v[k], false)) return true; }
    return false;
  }
  function enc(data) { return hasNested(data, false) ? { __json: JSON.stringify(data) } : data; }
  function dec(data) { if (data && typeof data.__json === 'string') { try { return JSON.parse(data.__json); } catch (e) { return {}; } } return data; }
  function err(e) {
    var map = { 'permission-denied': 'invalid_argument', 'resource-exhausted': 'resource_exhausted', 'unavailable': 'unavailable', 'unauthenticated': 'invalid_argument', 'cancelled': 'revoked' };
    var o = new Error(e && e.message || 'error'); o.code = (e && map[e.code]) || (e && e.code) || 'unknown'; o.raw = e; return o;
  }
  function wrapDoc(s) { var d = s.exists() ? dec(s.data()) : null; return { id: s.id, exists: !!d, data: function () { return d; } }; }
  function wrapQuery(docs) {
    var list = docs.map(function (s) { var d = dec(s.data()); return { id: s.id, exists: true, data: function () { return d; } }; });
    return { docs: list, size: list.length, empty: !list.length, forEach: function (f) { list.forEach(f); } };
  }
  function path(p) { var seg = String(p).split('/').filter(Boolean); seg[0] = APP + '_' + seg[0]; return seg; }

  function makeDb() {
    var fs = FB.fs, db = FB.db;
    function docRef(segs) {
      var ref = fs.doc.apply(null, [db].concat(segs));
      return {
        id: segs[segs.length - 1],
        get: function () { return fs.getDoc(ref).then(wrapDoc, function (e) { throw err(e); }); },
        set: function (data) { return fs.setDoc(ref, enc(data)).catch(function (e) { throw err(e); }); },
        update: function (data) { return fs.setDoc(ref, data, { merge: true }).catch(function (e) { throw err(e); }); },
        delete: function () { return fs.deleteDoc(ref).catch(function (e) { throw err(e); }); },
        onSnapshot: function (cb, onE) { return fs.onSnapshot(ref, function (s) { cb(wrapDoc(s)); }, function (e) { if (onE) onE(err(e)); }); },
        collection: function (n) { return colRef(segs.concat([n])); }
      };
    }
    function colRef(segs) {
      var full = segs.join('/');
      var scoped = SCOPED[full] && IHT.role !== 'admin';
      return {
        doc: function (id) { return docRef(segs.concat([id || fs.doc(fs.collection.apply(null, [db].concat(segs))).id])); },
        add: function (data) { var r = fs.doc(fs.collection.apply(null, [db].concat(segs))); return fs.setDoc(r, enc(data)).then(function () { return { id: r.id }; }, function (e) { throw err(e); }); },
        get: function () {
          if (scoped) return Promise.all(IHT.committees.map(function (id) { return fs.getDoc(fs.doc.apply(null, [db].concat(segs, [id]))); })).then(function (ss) { return wrapQuery(ss.filter(function (s) { return s.exists(); })); }, function (e) { throw err(e); });
          return fs.getDocs(fs.collection.apply(null, [db].concat(segs))).then(function (q) { return wrapQuery(q.docs); }, function (e) { throw err(e); });
        },
        onSnapshot: function (cb, onE) {
          if (scoped) {
            var cur = {}; var unsubs = IHT.committees.map(function (id) {
              return fs.onSnapshot(fs.doc.apply(null, [db].concat(segs, [id])), function (s) { if (s.exists()) cur[id] = s; else delete cur[id]; cb(wrapQuery(Object.keys(cur).map(function (k) { return cur[k]; }))); }, function (e) { if (onE) onE(err(e)); });
            });
            if (!unsubs.length) setTimeout(function () { cb(wrapQuery([])); }, 0);
            return function () { unsubs.forEach(function (u) { u(); }); };
          }
          return fs.onSnapshot(fs.collection.apply(null, [db].concat(segs)), function (q) { cb(wrapQuery(q.docs)); }, function (e) { if (onE) onE(err(e)); });
        }
      };
    }
    return {
      collection: function (n) { return colRef(path(n)); },
      doc: function (p) { return docRef(path(p)); },
      raw: FB // for the admin page
    };
  }
  function makeDownloads() {
    return {
      save: function (o) {
        return new Promise(function (res) {
          var blob = o.data instanceof Blob ? o.data : new Blob([o.data]);
          var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.filename || 'file';
          document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); res(); }, 400);
        });
      }
    };
  }
  window.claude = {
    use: function (name) {
      return ready.then(function () {
        if (name === 'db') return makeDb();
        if (name === 'user') return { canEdit: function () { return Promise.resolve(IHT.role === 'admin'); }, isOwner: function () { return Promise.resolve(IHT.role === 'admin'); }, me: function () { return Promise.resolve({ name: IHT.email }); } };
        if (name === 'downloads') return makeDownloads();
        return null; // mcp and others are not available outside Claude
      });
    }
  };

  // ---------- UI: gate, user chip, nav
  var css = '' +
    '.iht-gate{position:fixed;inset:0;z-index:100;background:linear-gradient(160deg,#12304F,#1F4E7C 55%,#2F6AA2);display:grid;place-items:center;padding:16px;direction:rtl;font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif}' +
    '.iht-card{background:#fff;color:#172433;border-radius:16px;width:min(420px,100%);padding:28px 24px;display:grid;gap:14px;box-shadow:0 24px 60px rgba(0,0,0,.3);text-align:center}' +
    '.iht-card .rule{display:grid;grid-template-columns:repeat(4,1fr);height:4px;border-radius:2px;overflow:hidden;margin:-28px -24px 6px}' +
    '.iht-card .rule i:nth-child(1){background:#FBB24C}.iht-card .rule i:nth-child(2){background:#9ACCED}.iht-card .rule i:nth-child(3){background:#F27362}.iht-card .rule i:nth-child(4){background:#2F6AA2}' +
    '.iht-card img{width:64px;height:64px;margin:0 auto}.iht-card h1{font-family:"Readex Pro","IBM Plex Sans Arabic",sans-serif;font-size:1.35rem;margin:0}.iht-card p{margin:0;color:#5E6B7A;font-size:.92rem;line-height:1.6}' +
    '.iht-btn{font:inherit;font-size:.95rem;border:1px solid #E2E7EE;background:#fff;color:#172433;border-radius:10px;padding:10px 14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}' +
    '.iht-btn.pri{background:#2F6AA2;border-color:#2F6AA2;color:#fff}.iht-btn:disabled{opacity:.6;cursor:default}' +
    '.iht-card input{font:inherit;padding:10px 12px;border:1px solid #E2E7EE;border-radius:10px;text-align:left;direction:ltr}' +
    '.iht-or{display:flex;align-items:center;gap:10px;color:#97989C;font-size:.8rem}.iht-or::before,.iht-or::after{content:"";flex:1;height:1px;background:#E2E7EE}' +
    '.iht-msg{font-size:.88rem;border-radius:8px;padding:8px 10px;background:#E6F0FA;color:#1F4E7C}.iht-msg.err{background:#FBE7E4;color:#C0473A}' +
    '.iht-me{display:flex;align-items:center;gap:8px;font-size:.8rem;color:#DCE7F2}.iht-me b{font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr}' +
    '.iht-me button{font:inherit;font-size:.78rem;background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:7px;padding:3px 9px;cursor:pointer}' +
    '.iht-role{background:#FBB24C;color:#163A5F;border-radius:6px;padding:1px 7px;font-weight:600}' +
    '[data-iht-admin][hidden]{display:none!important}';
  function addCss() { var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }
  var gate, card;
  function logo() { var i = document.querySelector('.bb-home img, .brand-blk img.mark'); return i ? i.src : ''; }
  function showGate(html) {
    if (!gate) { gate = document.createElement('div'); gate.className = 'iht-gate'; card = document.createElement('div'); card.className = 'iht-card'; gate.appendChild(card); document.body.appendChild(gate); }
    card.innerHTML = '<div class="rule"><i></i><i></i><i></i><i></i></div>' + (logo() ? '<img alt="" src="' + logo() + '">' : '') + html; gate.hidden = false;
  }
  function hideGate() { if (gate) gate.hidden = true; }
  function msg(t, bad) { var m = card && card.querySelector('.iht-msg'); if (m) { m.textContent = t; m.className = 'iht-msg' + (bad ? ' err' : ''); m.hidden = !t; } }
  function loginUI() {
    showGate('<h1>نظام إدارة احتواء</h1><p>سجّل الدخول بالإيميل المضاف لك من الإدارة.</p>' +
      '<button class="iht-btn pri" id="iht-g" type="button">الدخول بحساب Google</button>' +
      '<div class="iht-or">أو</div><input id="iht-e" type="email" placeholder="name@example.com" aria-label="البريد الإلكتروني" autocomplete="email">' +
      '<button class="iht-btn" id="iht-l" type="button">أرسل لي رابط دخول على الإيميل</button><div class="iht-msg" hidden></div>');
    card.querySelector('#iht-g').onclick = function () {
      var p = new FB.au.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
      FB.au.signInWithPopup(FB.auth, p).catch(function (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) return FB.au.signInWithRedirect(FB.auth, p);
        if (e && e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') msg('تعذر الدخول (' + e.code + ').', true);
      });
    };
    card.querySelector('#iht-l').onclick = function () {
      var em = card.querySelector('#iht-e').value.trim(); if (!/^\S+@\S+\.\S+$/.test(em)) { msg('اكتب بريداً إلكترونياً صحيحاً.', true); return; }
      var b = this; b.disabled = true;
      FB.au.sendSignInLinkToEmail(FB.auth, em, { url: location.href.split('#')[0].split('?')[0], handleCodeInApp: true }).then(function () {
        try { localStorage.setItem('iht-email', em); } catch (e) {}
        msg('أرسلنا رابط الدخول إلى ' + em + '. افتحه من نفس الجهاز والمتصفح.'); b.disabled = false;
      }, function (e) { msg('تعذر إرسال الرابط (' + (e && e.code) + ').', true); b.disabled = false; });
    };
  }
  function deniedUI(email) {
    showGate('<h1>لا تملك صلاحية الدخول</h1><p>الحساب <b dir="ltr">' + email + '</b> غير مضاف في النظام. تواصل مع إدارة احتواء لإضافتك، ثم أعد المحاولة.</p><button class="iht-btn" id="iht-o" type="button">الدخول بحساب آخر</button>');
    card.querySelector('#iht-o').onclick = function () { FB.au.signOut(FB.auth); };
  }
  function adminOnlyUI() {
    showGate('<h1>هذه الصفحة للإدارة فقط</h1><p>صلاحيتك تشمل خطة 2027 وهيكل اللجان ونظام التسجيل للجنتك.</p><a class="iht-btn pri" href="index.html" style="text-decoration:none">العودة لنظام الإدارة</a>');
  }
  function decorate() {
    var admin = IHT.role === 'admin';
    document.querySelectorAll('[data-iht-admin]').forEach(function (x) { x.hidden = !admin; });
    var host = document.querySelector('.bb-in') || document.querySelector('.side');
    if (!host || document.querySelector('.iht-me')) return;
    var me = document.createElement('div'); me.className = 'iht-me';
    me.innerHTML = '<span class="iht-role">' + (admin ? 'الإدارة' : 'قائد لجنة') + '</span><b title="' + IHT.email + '">' + IHT.email + '</b><button type="button">خروج</button>';
    me.querySelector('button').onclick = function () { FB.au.signOut(FB.auth).then(function () { location.reload(); }); };
    if (host.classList.contains('side')) { me.style.cssText = 'padding:10px 14px;flex-wrap:wrap'; var links = host.querySelector('.side-links'); host.insertBefore(me, links ? links.nextSibling : null); } else host.appendChild(me);
  }

  // ---------- boot
  function boot() {
    addCss();
    Promise.all([
      import('https://www.gstatic.com/firebasejs/' + V + '/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/' + V + '/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/' + V + '/firebase-firestore.js')
    ]).then(function (m) {
      var app = m[0].initializeApp(CONFIG);
      var auth = m[1].getAuth(app);
      var db = m[2].initializeFirestore(app, { ignoreUndefinedProperties: true });
      FB = { app: app, auth: auth, db: db, au: m[1], fs: m[2] }; window.IHT_RAW = FB;
      if (m[1].isSignInWithEmailLink(auth, location.href)) {
        var em = ''; try { em = localStorage.getItem('iht-email') || ''; } catch (e) {}
        if (!em) em = window.prompt('أكّد بريدك الإلكتروني لإكمال الدخول') || '';
        m[1].signInWithEmailLink(auth, em, location.href).then(function () { history.replaceState(null, '', location.pathname); }, function (e) { loginUI(); msg('الرابط منتهي أو مستخدم. اطلب رابطاً جديداً.', true); });
      }
      m[1].getRedirectResult(auth).catch(function () {});
      var started = false;
      m[1].onAuthStateChanged(auth, function (u) {
        if (!u) { if (started) location.reload(); loginUI(); return; }
        var email = String(u.email || '').toLowerCase();
        showGate('<h1>نظام إدارة احتواء</h1><p>جاري التحقق من الصلاحية…</p>');
        m[2].getDoc(m[2].doc(db, 'roles', email)).then(function (s) {
          var r = s.exists() ? s.data() : null;
          if (email === OWNER) r = { role: 'admin', committees: [], names: [] };
          if (!r || (r.role !== 'admin' && r.role !== 'leader')) { deniedUI(email); return; }
          IHT.role = r.role; IHT.email = email; IHT.committees = r.committees || []; IHT.names = r.names || []; IHT.uid = u.uid;
          decorate();
          if (ADMIN_ONLY && r.role !== 'admin') { adminOnlyUI(); return; }
          hideGate(); started = true; resolveReady(IHT);
        }, function (e) { deniedUI(email); });
      });
    }, function () {
      showGate('<h1>تعذر تحميل النظام</h1><p>تحقق من اتصال الإنترنت ثم أعد فتح الصفحة.</p>');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
