/* IQuit — основная логика приложения.
   Хранение: Telegram CloudStorage (без своего сервера).
   Ключи: iquit_state, iquit_friends, iquit_history.
   Вне браузера Telegram (локальный просмотр) — фолбэк на localStorage.
*/

(function () {
  'use strict';

  const D = window.IQDATA, A = window.IQALG;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // ---------- Telegram WebApp ----------
  const telem = window.Telegram && window.Telegram.WebApp;
  const IS_TG = !!(telem && telem.initData);

  // Фолбэк хранилище (вне Телеграма)
  const storage = {
    get(k, cb) { try { cb(localStorage.getItem(k)); } catch(e){ cb(null); } },
    set(k, v, cb) { try { localStorage.setItem(k, v); if(cb) cb(); } catch(e){ if(cb) cb(); } }
  };

  // Адаптер Telegram CloudStorage, если доступен
  const tgs = telem ? telem.CloudStorage : null;
  const useTG = !!(telem && tgs && tgs.getItem);

  function tgGet(key, cb) {
    if (useTG) { try { tgs.getItem(key, (err, v) => cb(err ? null : v)); } catch(e) { cb(null); } }
    else storage.get(key, cb);
  }
  function tgSet(key, val, cb) {
    if (useTG) { try { tgs.setItem(key, val, () => { if(cb) cb(); }); } catch(e) { if(cb) cb(); } }
    else storage.set(key, val, cb);
  }

  // ---------- Состояние ----------
  let state = {
    user: null,
    rounds: 0,          // сколько полных циклов теста пройдено
    answers: [],        // все ответы этого цикла [{catId, correct}]
    lastIQ: 0,
    lastWeak: [],       // catId последних завалов
    program: [],        // собранная программа [{catId, topics:{...}}]
    levels: {},         // прогресс по уровням: {catId: {lvl, courseDone:{lvl:true}}}
    myQuestions: [],    // вопросы мастера (созданные пользователем)
    reviewQueue: []     // вопросы мастеров для оценки
  };

  let friends = [];     // [{name, iq}]
  let history = [];     // [{iq, t}]

  function save(cb) {
    tgSet('iquit_state', JSON.stringify(state), () => {
      tgSet('iquit_friends', JSON.stringify(friends), () => {
        tgSet('iquit_history', JSON.stringify(history), cb);
      });
    });
  }

  function loadAll(cb) {
    tgGet('iquit_state', (s) => {
      tgGet('iquit_friends', (f) => {
        tgGet('iquit_history', (h) => {
          if (s) { try { state = Object.assign(state, JSON.parse(s)); } catch(e){} }
          if (f) { try { friends = JSON.parse(f); } catch(e){} }
          if (h) { try { history = JSON.parse(h); } catch(e){} }
          cb();
        });
      });
    });
  }

  // ---------- Имя пользователя ----------
  function userName() {
    if (telem && telem.initDataUnsafe && telem.initDataUnsafe.user) {
      const u = telem.initDataUnsafe.user;
      return (u.first_name || '') + (u.last_name ? ' ' + u.last_name : '');
    }
    return 'Игрок';
  }

  // Извлечение полных данных Telegram-пользователя из initDataUnsafe.
  let tgUser = null;
  function extractTgUser() {
    if (!(telem && telem.initDataUnsafe && telem.initDataUnsafe.user)) return null;
    const u = telem.initDataUnsafe.user;
    tgUser = {
      id: u.id != null ? String(u.id) : '',
      username: u.username || '',
      first: u.first_name || '',
      last: u.last_name || '',
      photo: u.photo_url || '',
      initData: telem.initData || '',
      lang: (u.language_code || 'ru').slice(0, 2)
    };
    return tgUser;
  }

  // Применить тему Telegram (светлая/тёмная) к CSS-переменным.
  function applyTgTheme() {
    const cs = (telem && telem.themeParams) ? telem.themeParams : null;
    if (!cs) return;
    const r = document.documentElement.style;
    if (cs.bg_color) r.setProperty('--bg', cs.bg_color);
    if (cs.text_color) r.setProperty('--ink', cs.text_color);
    if (cs.hint_color) r.setProperty('--muted', cs.hint_color);
    if (cs.button_color) r.setProperty('--accent', cs.button_color);
    if (cs.button_text_color) r.setProperty('--accent-ink', cs.button_text_color);
  }

  // Показ/скрытие системной MainButton Telegram.
  function setMainButton(show, text, onTap) {
    if (!telem || !telem.MainButton) return;
    try {
      if (show) {
        telem.MainButton.setParams({ text: text || 'Продолжить', is_visible: true, is_active: true });
        if (onTap) { telem.MainButton.onClick(onTap); }
      } else {
        telem.MainButton.hide();
      }
    } catch (e) {}
  }

  // ---- Проверка initData ----
  // Полную криптографическую проверку подписи (HMAC-SHA256 на основе токена бота)
  // можно выполнять ТОЛЬКО на сервере — хардкодить токен бота в клиентский код нельзя,
  // т.к. app.js лежит в открытом доступе на GitHub Pages и секрет будет раскрыт.
  // Здесь делаем безопасную структурную проверку: initData существует и содержит hash+user.
  let effectiveTg = false;

  function validateInitData() {
    if (!telem || !telem.initData) return false;
    try {
      const params = new URLSearchParams(telem.initData);
      const hasHash = !!params.get('hash');
      const hasUser = !!telem.initDataUnsafe && !!telem.initDataUnsafe.user;
      effectiveTg = hasHash && hasUser;
    } catch (e) {
      effectiveTg = false;
    }
    return effectiveTg;
  }

  // ---------- Навигация по экранам ----------
  function show(id) {
    $$('.screen').forEach(s => s.classList.add('hidden'));
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  // ---------- Вопросы теста ----------
  // Собираем тест из всех категорий равномерно.
  function buildQuiz() {
    const per = Math.max(1, Math.ceil(10 / D.CATEGORIES.length));
    const items = [];
    D.CATEGORIES.forEach(c => {
      const pool = shuffle(D.PRACTICE[c.id] || []);
      for (let i = 0; i < per && i < pool.length; i++) {
        items.push({ catId: c.id, ...pool[i] });
      }
    });
    // Перемешаем, сохранив общий порядок категорий
    return shuffle(items).slice(0, 12);
  }
  function shuffle(arr) { return D ? (A.shuffle ? A.shuffle(arr) : arr) : arr; }

  // Перемешивает варианты вопроса и возвращает объект с обновлённым a (значение ответа сохраняется).
  function shuffleOptions(q) {
    const opts = q.options.slice();
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opts[i], opts[j]] = [opts[j], opts[i]];
    }
    return { options: opts, a: q.a };
  }

  // ---------- Текущий тест ----------
  let quiz = [];
  let quizIdx = 0;
  let quizResult = [];   // [{catId, correct}]

  let memoTimer = null;
  const QUESTION_TIME = 30; // секунд на вопрос
  let qtimer = null;         // таймер обратного отсчёта на вопрос
  let qtRemain = QUESTION_TIME;

  function clearQTimer() {
    if (qtimer) { clearInterval(qtimer); qtimer = null; }
  }
  // Запускает отсчёт при показе вопроса (после запоминания, если оно есть)
  function startQTimer(onTimeout) {
    clearQTimer();
    qtRemain = QUESTION_TIME;
    const ticks = $('#quiz-timer-ticks'), fill = $('#quiz-timer-fill');
    const wrap = $('#quiz-timer');
    if (ticks) ticks.textContent = qtRemain;
    if (fill) fill.style.width = '100%';
    if (wrap) wrap.classList.remove('low');
    const start = Date.now();
    qtimer = setInterval(() => {
      const el = (QUESTION_TIME - (Date.now() - start) / 1000);
      const left = Math.max(0, Math.ceil(el));
      if (ticks) ticks.textContent = Math.max(0, Math.floor(el));
      if (fill) fill.style.width = Math.max(0, (el / QUESTION_TIME) * 100) + '%';
      if (wrap && left <= 5) wrap.classList.add('low');
      if (el <= 0) {
        clearQTimer();
        if (onTimeout) onTimeout();
      }
    }, 200);
  }

  function renderQuiz() {
    const q = quiz[quizIdx];
    const c = D.catById[q.catId];
    $('#quiz-chip-dot').style.background = c.color;
    $('#quiz-chip-name').textContent = c.name;
    $('#quiz-counter').textContent = (quizIdx + 1) + ' / ' + quiz.length;

    const body = $('#quiz-body');
    body.innerHTML = `
      <div class="topic-img-wrap"><img src="${c.img}" alt="${c.name}"></div>
      <div class="q-text" id="quiz-q"></div>
      <div class="options" id="quiz-options"></div>
      <div class="explain hidden" id="quiz-explain"></div>`;

    // Вопросы на память: сначала показываем ряд для запоминания, потом вопрос.
    if (q.memo) {
      body.innerHTML = `
        <div class="topic-img-wrap"><img src="${c.img}" alt="${c.name}"></div>
        <div class="memo-wrap">
          <p class="q-text" style="margin-top:0">Запомни этот ряд</p>
          <div class="memo-stage">${q.memo.split('·').map(x => `<div class="memo-card">${x.trim()}</div>`).join('')}</div>
          <div class="memo-timerbar"><div class="memo-timerfill" id="memo-timerfill"></div></div>
          <div class="memo-hint">Ряд скоро исчезнет</div>
        </div>`;
      const timerfill = $('#memo-timerfill');
      timerfill.style.width = '100%';
      // Время запоминания ~ 1 сек на элемент
      const total = Math.max(3, q.memo.split('·').length);
      timerfill.style.transition = 'width ' + total + 's linear';
      requestAnimationFrame(() => { timerfill.style.width = '0%'; });
      const reveal = () => renderQuizQuestion(q, c);
      memoTimer = setTimeout(reveal, total * 1000);
      body.querySelector('.memo-wrap').addEventListener('click', () => {
        if (memoTimer) { clearTimeout(memoTimer); memoTimer = null; }
        reveal();
      });
    } else {
      renderQuizQuestion(q, c);
    }
  }

  function renderQuizQuestion(q, c, onChoose) {
    const body = $('#quiz-body');
    body.innerHTML = `
      <div class="topic-img-wrap"><img src="${c.img}" alt="${c.name}"></div>
      <div class="q-text" id="quiz-q"></div>
      <div class="options" id="quiz-options"></div>
      <div class="explain hidden" id="quiz-explain"></div>`;
    $('#quiz-q').textContent = q.q;
    $('#quiz-options').innerHTML = '';
    const keys = ['A', 'B', 'C', 'D'];
    const shuffled = shuffleOptions(q);
    shuffled.options.forEach((opt, i) => {
      const b = document.createElement('div');
      b.className = 'opt';
      b.dataset.i = i;
      b.innerHTML = `<div class="key">${keys[i]}</div><div class="val">${opt}</div>`;
      b.addEventListener('click', () => (onChoose || chooseQuiz)(i, b, shuffled.options, shuffled.a));
      $('#quiz-options').appendChild(b);
    });
    $('#quiz-explain').classList.add('hidden');
    $('#quiz-next').classList.add('hidden');

    // Автозавершение вопроса по истечении 30с
    const self = this;
    startQTimer(() => {
      const target = inPractice ? practice[pracIdx] : quiz[quizIdx];
      const optsEls = document.querySelectorAll('#quiz-body .opt');
      const shuffled = shuffleOptions(target);
      if (!optsEls.length || !target) return;
      // эмулируем выбор заведомо неверного: нажимаем на вариант, не совпадающий с ответом
      const wrongIdx = shuffled.options.findIndex((o) => String(o) !== String(shuffled.a));
      if (wrongIdx >= 0) {
        (onChoose || chooseQuiz)(wrongIdx, optsEls[wrongIdx], shuffled.options, shuffled.a);
      }
    });
  }

  function chooseQuiz(i, el, opts, ans) {
    clearQTimer();
    const q = quiz[quizIdx];
    const correct = opts[i] === ans;
    // Подсветка
    $$('#quiz-options .opt').forEach(o => o.classList.remove('chosen','correct','wrong'));
    el.classList.add(correct ? 'correct' : 'wrong');
    if (!correct) {
      const ci = opts.indexOf(ans);
      if (ci >= 0) $$('#quiz-options .opt')[ci].classList.add('correct');
    }
    const ex = $('#quiz-explain');
    if (q.explain) ex.innerHTML = q.explain; else ex.innerHTML = `<b>${correct ? 'Верно!' : 'Неверно.'}</b> Правильный ответ: ${ans}`;
    ex.classList.remove('hidden');
    $('#quiz-next').classList.remove('hidden');
    quizResult.push({ catId: q.catId, correct });
  }

  function nextQuiz() {
    clearQTimer();
    if (memoTimer) { clearTimeout(memoTimer); memoTimer = null; }
    quizIdx++;
    if (quizIdx < quiz.length) { renderQuiz(); }
    else finishQuiz();
  }

  function finishQuiz() {
    // Алгоритм: баллы по темам
    const scores = A.scoreTopics(quizResult);
    const iq = A.computeIQ(scores);
    const weak = A.weakTopics(scores, 2);
    const program = A.buildProgram(scores, { minWeak: 2 });

    state.rounds++;
    state.answers = state.answers.concat(quizResult);
    state.lastIQ = iq;
    state.lastWeak = weak.map(w => w.catId);
    state.program = program;
    history.unshift({ iq, t: Date.now() });
    history = history.slice(0, 30);

    // Сохраняем и показываем результат
    save(() => renderResult(iq, scores, weak, program));
  }

  function renderResult(iq, scores, weak, program) {
    setMainButton(false);
    $('#res-iq').textContent = iq;
    const label = iq >= 120 ? 'Высокий IQ' : iq >= 100 ? 'Хороший IQ' : iq >= 80 ? 'Средний IQ' : 'Тренируйся активнее';
    $('#res-label').textContent = label;
    const totalOk = quizResult.filter(r => r.correct).length;
    $('#res-sub').textContent = `Верно ${totalOk} из ${quizResult.length}`;

    const list = $('#res-weak');
    list.innerHTML = '';
    if (weak.length) {
      weak.forEach(w => {
        const c = D.catById[w.catId];
        const pct = Math.round(w.score * 100);
        const item = document.createElement('div');
        item.className = 'prog-item';
        item.innerHTML = `
          <img class="thumb" src="${c.img}" alt="">
          <div class="pi-inf">
            <div class="pi-t">${c.name}</div>
            <div class="pi-s">Правильно ${pct}%</div>
          </div>
          <span class="badge weak">Прокачать</span>`;
        list.appendChild(item);
      });
    } else {
      list.innerHTML = '<div class="muted">Отлично, завалов нет! Тренируйся дальше.</div>';
    }

    $('#res-explain').innerHTML = '';
    show('screen-result');
  }

  // ---------- ПРОГРАММА ----------
  function renderProgram() {
    const cont = $('#program-theory');
    cont.innerHTML = '';
    if (!state.program || !state.program.length) {
      cont.innerHTML = '<div class="muted">Программа ещё не построена. Сначала пройди тест.</div>';
      return;
    }
    state.program.forEach(seg => {
      const c = D.catById[seg.catId];
      const block = document.createElement('div');
      block.className = 'theory-block';
      let h = `<h3><span class="dot" style="background:${c.color}"></span>${c.name}</h3>`;
      (seg.topics.theoryShort || []).forEach(t => h += `<p>${t}</p>`);
      (seg.topics.theoryLong || []).forEach(t => h += `<p><b>Углублённо:</b> ${t}</p>`);
      block.innerHTML = h;
      cont.appendChild(block);
    });
  }

  // ---------- Практика ----------
  let practice = [];
  let pracIdx = 0;
  let pracResult = [];
  let pracWeak = 0, pracTotal = 0, inPractice = false;

  function startPractice() {
    practice = [];
    pracResult = [];
    pracWeak = 0; pracTotal = 0;
    inPractice = true;
    setMainButton(true, 'Далее');
    // Собираем практику из всех заваленных тем программы
    (state.program || []).forEach(seg => {
      (seg.topics.practice || []).forEach(p => practice.push({ catId: seg.catId, ...p }));
    });
    practice = shuffle(practice);
    if (!practice.length) { alert('Практика пока пуста — пройди тест.'); return; }
    pracIdx = 0;
    show('screen-quiz');
    // переиспользуем экран теста, но переключим заголовок
    renderPractice();
  }
  function renderPractice() {
    const q = practice[pracIdx];
    const c = D.catById[q.catId];
    $('#quiz-chip-dot').style.background = c.color;
    $('#quiz-chip-name').textContent = 'Практика · ' + c.name;
    $('#quiz-counter').textContent = (pracIdx + 1) + ' / ' + practice.length;

    const body = $('#quiz-body');
    if (q.memo) {
      body.innerHTML = `
        <div class="topic-img-wrap"><img src="${c.img}" alt="${c.name}"></div>
        <div class="memo-wrap">
          <p class="q-text" style="margin-top:0">Запомни этот ряд</p>
          <div class="memo-stage">${q.memo.split('·').map(x => `<div class="memo-card">${x.trim()}</div>`).join('')}</div>
          <div class="memo-timerbar"><div class="memo-timerfill" id="memo-timerfill"></div></div>
          <div class="memo-hint">Ряд скоро исчезнет</div>
        </div>`;
      const timerfill = $('#memo-timerfill');
      timerfill.style.width = '100%';
      const total = Math.max(3, q.memo.split('·').length);
      timerfill.style.transition = 'width ' + total + 's linear';
      requestAnimationFrame(() => { timerfill.style.width = '0%'; });
      if (memoTimer) clearTimeout(memoTimer);
      const reveal = () => renderQuizQuestion(q, c, choosePractice);
      memoTimer = setTimeout(reveal, total * 1000);
      body.querySelector('.memo-wrap').addEventListener('click', () => {
        if (memoTimer) { clearTimeout(memoTimer); memoTimer = null; }
        reveal();
      });
    } else {
      renderQuizQuestion(q, c, choosePractice);
    }
  }
  function choosePractice(i, el, opts, ans) {
    clearQTimer();
    const q = practice[pracIdx];
    const correct = opts[i] === ans;
    pracTotal++;
    if (correct) pracWeak++; // учитывая, практика идёт именно на слабые темы — просто счётчик правильных
    $$('#quiz-options .opt').forEach(o => o.classList.remove('chosen','correct','wrong'));
    el.classList.add(correct ? 'correct' : 'wrong');
    if (!correct) {
      const ci = opts.indexOf(ans);
      if (ci >= 0) $$('#quiz-options .opt')[ci].classList.add('correct');
    }
    const ex = $('#quiz-explain');
    ex.innerHTML = correct ? `<b>Верно!</b> ${q.explain ? ' ' + q.explain : ''}` : `<b>Неверно.</b> Правильный: ${ans}`;
    ex.classList.remove('hidden');
    $('#quiz-next').classList.remove('hidden');
  }
  function nextPractice() {
    clearQTimer();
    pracIdx++;
    if (pracIdx < practice.length) renderPractice();
    else {
      // Сохранить результат в историю (как ещё один "раунд"), показать результат
      history.unshift({ iq: state.lastIQ, t: Date.now(), practice: true, right: pracWeak, total: pracTotal });
      save(() => {
        setMainButton(false);
        show('screen-result');
        $('#res-iq').textContent = state.lastIQ || '—';
        $('#res-label').textContent = 'Практика завершена';
        $('#res-sub').textContent = `Справился: ${pracWeak} из ${pracTotal} в практике`;
        $('#res-weak').innerHTML = '<div class="muted">Молодец! Пройди новый тест, чтобы алгоритм пересчитал завалы.</div>';
        $('#btn-open-program').classList.add('hidden');
      });
    }
  }

  // ---------- УДАРНЫЙ РЕЖИМ (быстрый раунд с таймером) ----------
  let speed = [];
  let speedIdx = 0;
  let speedScore = 0;
  let speedTimer = null;
  let speedTime = 0;

  function startSpeed() {
    // один раунд вперемешку категорий
    const per = Math.max(1, Math.round(8 / D.CATEGORIES.length));
    speed = [];
    D.CATEGORIES.forEach(c => {
      const pool = shuffle(D.PRACTICE[c.id] || []);
      for (let i = 0; i < per && i < pool.length; i++) speed.push({ catId: c.id, ...pool[i] });
    });
    speed = shuffle(speed).slice(0, 8);
    speedIdx = 0; speedScore = 0; speedTime = 45;
    show('screen-speedquiz');
    renderSpeed();
    speedTimer = setInterval(() => {
      speedTime--;
      $('#speed-counter').textContent = speedTime + 'с';
      if (speedTime <= 0) endSpeed();
    }, 1000);
  }
  function renderSpeed() {
    const q = speed[speedIdx];
    const c = D.catById[q.catId];
    $('#speed-chip-dot').style.background = c.color;
    $('#speed-chip-name').textContent = c.name;
    $('#speed-q').textContent = q.q;
    $('#speed-options').innerHTML = '';
    const keys = ['A','B','C','D'];
    const shuffled = shuffleOptions(q);
    shuffled.options.forEach((opt, i) => {
      const b = document.createElement('div');
      b.className = 'opt'; b.dataset.i = i;
      b.innerHTML = `<div class="key">${keys[i]}</div><div class="val">${opt}</div>`;
      b.addEventListener('click', () => chooseSpeed(i, b, shuffled.options, shuffled.a));
      $('#speed-options').appendChild(b);
    });
  }
  function chooseSpeed(i, el, opts, ans) {
    const q = speed[speedIdx];
    const correct = opts[i] === ans;
    if (correct) speedScore++;
    $$('#speed-options .opt').forEach(o => o.classList.remove('chosen','correct','wrong'));
    el.classList.add(correct ? 'correct' : 'wrong');
    if (!correct) { const ci = opts.indexOf(ans); if (ci>=0) $$('#speed-options .opt')[ci].classList.add('correct'); }
    setTimeout(() => { speedIdx++; if (speedIdx < speed.length) renderSpeed(); else endSpeed(); }, 600);
  }
  function endSpeed() {
    if (speedTimer) clearInterval(speedTimer);
    history.unshift({ iq: Math.round(state.lastIQ || 80), t: Date.now(), speed: true, right: speedScore, total: speed.length });
    save(() => {
      show('screen-result');
      $('#res-iq').textContent = speedScore + ' / ' + speed.length;
      $('#res-label').textContent = 'Ударный раунд';
      $('#res-sub').textContent = `Набрано очков: ${speedScore}`;
      $('#res-weak').innerHTML = '<div class="muted">Ты молодец. Брось вызов другу — кто быстрее и точнее?</div>';
      if ($('#btn-open-program')) $('#btn-open-program').classList.add('hidden');
    });
  }

  // ---------- Друзья / рейтинг ----------
  function renderFriends() {
    const list = $('#friends-list');
    list.innerHTML = '';
    const rows = friends.slice().sort((a,b) => b.iq - a.iq);
    if (!rows.length) { list.innerHTML = '<div class="muted center">Пока нет данных. Пригласи друзей!</div>'; return; }
    rows.forEach((f, idx) => {
      const isMe = f.name === state.user;
      const r = document.createElement('div');
      r.className = 'rank-row' + (isMe ? ' me' : '');
      r.innerHTML = `<div class="pos">${idx+1}</div><div class="dot" style="background:${idx===0?'#ffd166':'rgba(255,255,255,0.3)'}"></div>
        <div class="aname">${esc(f.name)}</div><div class="aiq">${f.iq}</div>`;
      list.appendChild(r);
    });
  }
  function esc(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  // ---------- Профиль ----------
  function renderProfile() {
    renderUserBadge();
    $('#prof-name').textContent = state.user || 'Игрок';
    const profSub = $('#prof-sub');
    const sub = tgUser && tgUser.username ? '@' + tgUser.username : (state.user || 'Игрок');
    profSub.textContent = `${sub} · IQ: ${state.lastIQ || '—'} · Циклов: ${state.rounds}`;
    const h = $('#prof-history');
    h.innerHTML = '';
    // Диагностика Telegram (временная, для отладки «Игрок вместо ника»)
    let diag = '';
    try {
      if (typeof window.Telegram === 'undefined') diag = 'TG API: НЕ загружен (SDK telegram.org)';
      else if (!window.Telegram.WebApp) diag = 'TG API: WebApp отсутствует';
      else diag = 'TG: initData ' + (window.Telegram.WebApp.initData ? 'есть' : 'НЕТ')
        + ' · user ' + (window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user ? 'есть (имя=' + (window.Telegram.WebApp.initDataUnsafe.user.first_name || '?') + ')' : 'НЕТ');
    } catch (e) { diag = 'TG: ошибка ' + e; }
    let dEl = document.getElementById('prof-diag');
    if (!dEl) {
      const box = document.createElement('div');
      box.id = 'prof-diag'; box.className = 'muted';
      h.appendChild(box);
      dEl = box;
    }
    dEl.textContent = diag;
    if (!history.length) { return; }
    history.slice(0, 10).forEach(ev => {
      const d = new Date(ev.t);
      const p = document.createElement('div');
      p.className = 'rank-row';
      const label = ev.speed ? `Ударный раунд: ${ev.right}/${ev.total}` : ev.practice ? `Практика: ${ev.right}/${ev.total}` : `IQ: ${ev.iq}`;
      p.innerHTML = `<div class="pos"></div><div class="aname">${label}</div><div class="muted" style="font-size:12px">${d.toLocaleDateString()}</div>`;
      h.appendChild(p);
    });
  }

  // ---------- УРОВНИ / КУРСЫ / МАСТЕР ----------
  const LV = window.IQLEVELS;

  // Текущий уровень темы для игрока
  function curLevel(catId) {
    const l = (state.levels && state.levels[catId]) ? state.levels[catId].lvl || 1 : 1;
    return Math.min(LV.MAX_LEVEL, Math.max(1, l));
  }
  function setLevel(catId, lvl) {
    state.levels = state.levels || {};
    state.levels[catId] = state.levels[catId] || {};
    state.levels[catId].lvl = Math.min(LV.MAX_LEVEL, Math.max(1, lvl));
  }
  // Прошёл ли курс определённого уровня (для 10+ практика заблокирована)
  function courseDone(catId, lvl) {
    return !!(state.levels && state.levels[catId] && state.levels[catId].courseDone && state.levels[catId].courseDone[lvl]);
  }
  function markCourseDone(catId, lvl) {
    state.levels = state.levels || {};
    state.levels[catId] = state.levels[catId] || {};
    state.levels[catId].courseDone = state.levels[catId].courseDone || {};
    state.levels[catId].courseDone[lvl] = true;
  }

  function renderLevels(catId) {
    const cat = D.catById[catId];
    $('#levels-topic-img').src = cat.img;
    $('#levels-topic-name').textContent = cat.name;
    const lvl = curLevel(catId);
    $('#levels-title').textContent = cat.name;
    $('#levels-progress').textContent = 'Уровень ' + lvl + ' · ' + LV.LEVEL_NAMES[lvl-1];
    $('#levels-bar-fill').style.width = Math.round((lvl / LV.MAX_LEVEL) * 100) + '%';
    $('#levels-count').textContent = lvl + ' из ' + LV.MAX_LEVEL;

    // Теория уровня
    const th = LV.levelThemes[catId] && LV.levelThemes[catId][lvl-1];
    const theCont = $('#levels-theory');
    theCont.innerHTML = '';
    if (th) {
      const h = document.createElement('div');
      h.innerHTML = `<span class="dot" style="background:${cat.color}"></span> Уровень ${lvl}: ${LV.LEVEL_NAMES[lvl-1]}`;
      h.style.fontWeight = '800'; h.style.marginBottom = '8px';
      theCont.appendChild(h);
      const p = document.createElement('p');
      p.textContent = th[0] + (th[1] ? ' ' + th[1] : '');
      theCont.appendChild(p);
    }

    // Курсы с 10 уровня
    const ca = $('#levels-course-aware');
    ca.innerHTML = '';
    $('#btn-open-course').classList.add('hidden');
    if (lvl >= LV.COURSE_START && LV.courses[catId] && LV.courses[catId][lvl]) {
      ca.innerHTML = '';
      if (!courseDone(catId, lvl)) {
        $('#btn-open-course').classList.remove('hidden');
      } else {
        ca.innerHTML = '<div class="blocker">Курс этого уровня пройден. Практика открыта.</div>';
      }
    }

    // Блокер практики
    const bl = $('#levels-practice-blocker');
    bl.innerHTML = '';
    $('#btn-level-practice').classList.remove('hidden');
    if (lvl >= LV.COURSE_START && LV.courses[catId] && LV.courses[catId][lvl] && !courseDone(catId, lvl)) {
      bl.innerHTML = '<div class="blocker">До прохождения курса уровня ' + lvl + ' новая практика недоступна.</div>';
      $('#btn-level-practice').classList.add('hidden');
    }

    // Мастер-режим открывается на последнем уровне
    $('#btn-master-mode').classList.add('hidden');
    if (lvl >= LV.MAX_LEVEL) $('#btn-master-mode').classList.remove('hidden');

    state.currentTopic = catId;
    save();
  }

  // Открыть курс (уроки уровня)
  function openCourse(catId) {
    const lvl = curLevel(catId);
    const course = LV.courses[catId] && LV.courses[catId][lvl];
    if (!course) { show('screen-levels'); return; }
    $('#course-title').textContent = course.title || ('Курс уровня ' + lvl);
    courseState = { catId: catId, lvl: lvl, idx: 0, course: course.lessons };
    renderCourseLesson();
    show('screen-course');
  }
  let courseState = null;
  function renderCourseLesson() {
    const c = courseState;
    const lesson = c.course[c.idx];
    const body = $('#course-body');
    const progress = (c.idx + 1) + ' / ' + c.course.length;
    body.innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:8px">Урок ${progress}</div>`
      + `<div class="course-lesson"><div class="lt">${lesson.title}</div><div class="lc">${lesson.content}</div></div>`;
    const isLast = c.idx === c.course.length - 1;
    $('#btn-course-next').textContent = isLast ? 'Завершить курс' : 'Следующий урок';
  }

  // Перейти к практике уровня
  function startLevelPractice() {
    const catId = state.currentTopic;
    const lvl = curLevel(catId);
    // практика уровня: берём базовый пул + сложные вопросы подходящего уровня
    practice = [];
    const base = D.PRACTICE[catId] || [];
    base.forEach(p => practice.push({ catId, level: lvl, ...p }));
    const hard = (LV.hardQuestions || []).filter(h => h.catId === catId && h.level <= lvl + 1);
    hard.forEach(h => practice.push({ catId, level: h.level, ...h }));
    practice = shuffle(practice).slice(0, 10);
    pracIdx = 0; pracTotal = 0; pracWeak = 0; inPractice = true;
    show('screen-quiz'); renderPractice();
  }

  // ---------- МАСТЕР-РЕЖИМ ----------
  function renderMasterForm() {
    const sel = $('#master-cat');
    sel.innerHTML = '';
    D.CATEGORIES.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      sel.appendChild(o);
    });
    $('#master-status').classList.add('hidden');
  }
  function openMaster() {
    renderMasterForm();
    renderReviewList();
    show('screen-master');
  }
  // Алгоритмическая модерация: формат, полнота, #дубли по тексту
  function moderateQuestion(q, opts, ans) {
    if (!q || !q.trim()) return 'Пустой вопрос';
    if (q.trim().length < 10) return 'Вопрос слишком короткий';
    if (!ans || !ans.trim()) return 'Нет правильного ответа';
    const all = [ans].concat(opts.filter(Boolean));
    const uniq = new Set(all.map(s => s.trim().toLowerCase()));
    if (uniq.size !== all.length) return 'Варианты повторяются (должны быть уникальны)';
    if (all.length < 4) return 'Нужно 4 разных варианта';
    // дубли в базе и в моих вопросах
    const norm = q.trim().toLowerCase();
    const dupBase = D.PRACTICE[ $('#master-cat').value ].some(b => b.q.toLowerCase() === norm);
    const dupMine = state.myQuestions.some(m => m.q.toLowerCase() === norm);
    if (dupBase || dupMine) return 'Похожий вопрос уже есть (дубликат)';
    return null;
  }
  function submitMasterQuestion() {
    const catId = $('#master-cat').value;
    const q = $('#master-q').value;
    const a = $('#master-a').value;
    const b = $('#master-b').value;
    const c = $('#master-c').value;
    const d = $('#master-d').value;
    const st = $('#master-status');
    const err = moderateQuestion(q, [a, b, c, d], a);
    if (err) {
      st.innerHTML = `<b>Модерация не пройдена.</b> ${err}`;
      st.classList.remove('hidden');
      return;
    }
    const qObj = { catId, q: q.trim(), options: [a.trim(), b.trim(), c.trim(), d.trim()], a: a.trim(), by: state.user, level: LV.MAX_LEVEL };
    state.myQuestions.push(qObj);
    state.reviewQueue = state.reviewQueue || [];
    state.reviewQueue.push(qObj);
    save(() => {
      st.innerHTML = `<b>Готово.</b> Вопрос принят и добавлен в очередь на решение мастерами.`;
      st.classList.remove('hidden');
      $('#master-q').value = $('#master-a').value = $('#master-b').value = $('#master-c').value = $('#master-d').value = '';
      renderReviewList();
    });
  }
  function renderReviewList() {
    const list = $('#master-review-list');
    list.innerHTML = '';
    const qs = state.reviewQueue || [];
    if (!qs.length) { list.innerHTML = '<div class="muted center">Пока нет вопросов от мастеров.</div>'; return; }
    const unique = qs.filter((v, i, arr) => arr.findIndex(x => x.q === v.q) === i);
    unique.slice(0, 5).forEach(x => {
      const it = document.createElement('div');
      it.className = 'master-item';
      const cat = D.catById[x.catId];
      it.innerHTML = `<span class="dot" style="background:${cat.color}"></span> <span class="mq">${esc(x.q)}</span> <span class="muted" style="font-size:12px">(${cat.name})</span>`;
      list.appendChild(it);
    });
  }
  // Решить чужой вопрос: запускаем как практику из reviewQueue
  function reviewForeignQuestion() {
    const qs = state.reviewQueue || [];
    const unique = qs.filter((v, i, arr) => arr.findIndex(x => x.q === v.q) === i);
    if (!unique.length) { alert('Вопросов мастеров пока нет.'); return; }
    const q = unique[Math.floor(Math.random() * unique.length)];
    practice = [{ catId: q.catId, ...q }];
    pracIdx = 0; pracTotal = 0; pracWeak = 0; inPractice = true;
    show('screen-quiz'); renderPractice();
  }

  // ---------- Инициализация ----------
  function init() {
    // Диагностика Telegram (для отладки «Игрок вместо ника»)
    try {
      console.log('[IQuit-diag] telem=', !!window.Telegram,
        'initData=', !!(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData),
        'user=', window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe &&
          (window.Telegram.WebApp.initDataUnsafe.user || null));
    } catch (e) { console.log('[IQuit-diag] err', e); }
    extractTgUser();
    state.user = userName();
    applyTgTheme();
    renderUserBadge();
    show('screen-home');
    $('#home-name').textContent = state.user;
    $('#home-avatar').textContent = (state.user[0] || '?').toUpperCase();
    $('#home-meta').textContent = state.lastIQ ? `IQ: ${state.lastIQ} · Циклов: ${state.rounds}` : 'IQ: — · Начни с теста';
    if (telem) {
      telem.ready();
      telem.expand();
      try { telem.setHeaderColor('#0f1023'); telem.setBackgroundColor('#0f1023'); } catch(e){}
      try { if (telem.HapticFeedback) telem.HapticFeedback.impactOccurred('light'); } catch(e){}
    }
    $('#loading-screen').classList.add('hidden');
    $('#app-root').classList.add('active');
  }

  // Заполнить аватар (и фото Telegram, если есть) в шапке и в профиле.
  function renderUserBadge() {
    const photo = tgUser && tgUser.photo;
    if (photo) {
      const avs = $$('#home-avatar, #prof-avatar');
      avs.forEach(a => {
        a.style.backgroundImage = 'url("' + photo + '")';
        a.style.backgroundSize = 'cover';
        a.style.backgroundPosition = 'center';
        a.textContent = '';
      });
    }
    // подпись в профеле: username
    const profSub = $('#prof-sub');
    if (profSub && tgUser && tgUser.username) {
      profSub.textContent = '@' + tgUser.username + (state.lastIQ ? ' · IQ: ' + state.lastIQ : '');
    }
  }

  // ---------- События ----------
  function bind() {
    $('#btn-start-test').addEventListener('click', () => {
      inPractice = false;
      setMainButton(true, 'Далее');
      quiz = buildQuiz(); quizIdx = 0; quizResult = [];
      show('screen-quiz'); renderQuiz();
    });
    $('#btn-my-plan').addEventListener('click', () => { renderProgram(); show('screen-program'); });
    $('#btn-home-shock').addEventListener('click', () => { renderFriends(); show('screen-shock'); });
    $('#btn-home-friends').addEventListener('click', () => { renderFriends(); show('screen-friends'); });
    $('#btn-home-profile').addEventListener('click', () => { renderProfile(); show('screen-profile'); });
    $('#btn-home-levels').addEventListener('click', () => {
      if (!state.lastWeak.length) {
        // нет слабых тем — открываем первую
        state.currentTopic = D.CATEGORIES[0].id;
        renderLevels(state.currentTopic); show('screen-levels'); return;
      }
      // выберем тему: простой способ — спросить, но используем маленький выбор
      const cat = D.catById[state.lastWeak[ Math.floor(Math.random()*state.lastWeak.length) ]] || D.CATEGORIES[0];
      state.currentTopic = cat.id;
      renderLevels(cat.id); show('screen-levels');
    });

    $('#quiz-next').addEventListener('click', () => {
      if (memoTimer) { clearTimeout(memoTimer); memoTimer = null; }
      if (inPractice) nextPractice();
      else nextQuiz();
    });
    // Системная MainButton Telegram — дубль кнопки «Далее» в тесте/практике
    if (telem && telem.MainButton) {
      telem.MainButton.onClick(() => {
        if (memoTimer) { clearTimeout(memoTimer); memoTimer = null; }
        if (inPractice) nextPractice();
        else nextQuiz();
      });
    }

    $('#btn-open-program').addEventListener('click', () => { renderProgram(); show('screen-program'); });
    $('#btn-result-home').addEventListener('click', () => show('screen-home'));

    $('#btn-start-practice').addEventListener('click', startPractice);
    $('#btn-level-practice').addEventListener('click', startLevelPractice);
    $('#btn-open-course').addEventListener('click', () => { if (state.currentTopic) openCourse(state.currentTopic); });
    $('#btn-course-next').addEventListener('click', () => {
      if (courseState) {
        courseState.idx++;
        if (courseState.idx < courseState.course.length) {
          renderCourseLesson();
        } else {
          markCourseDone(courseState.catId, courseState.lvl);
          save(() => { show('screen-levels'); renderLevels(courseState.catId); });
        }
      }
    });
    $('#btn-master-mode').addEventListener('click', openMaster);
    $('#btn-master-submit').addEventListener('click', submitMasterQuestion);
    $('#btn-master-review').addEventListener('click', reviewForeignQuestion);

    $('#btn-shock-1v1').addEventListener('click', () => startSpeed());
    $('#btn-shock-solo').addEventListener('click', () => startSpeed());

    $('#btn-invite').addEventListener('click', () => {
      const link = IS_TG && window.location.href ? window.location.href : 'https://t.me/YourIQuitBot';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(() => $('#btn-invite').textContent = 'Скопировано!');
      } else {
        prompt('Ссылка на бота:', link);
      }
    });

    $('#btn-reset-progress').addEventListener('click', () => {
      if (confirm('Сбросить весь прогресс?')) {
        state = { user: state.user, rounds: 0, answers: [], lastIQ: 0, lastWeak: [], program: [] };
        history = []; friends = [];
        save(() => { renderProfile(); show('screen-home'); location.reload(); });
      }
    });

    // Кнопки «назад»
    $$('.btn-back').forEach(b => b.addEventListener('click', () => show(b.dataset.back || 'screen-home')));
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadAll(() => {
      validateInitData();
      init(); bind();
    });
  });

})();