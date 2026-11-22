/* IQuit — алгоритмы анализа и сборки персональной программы
   Чистая логика без DOM. Работает офлайн.

   Принцип:
   1. По результатам теста считаем балл каждой темы (доля правильных).
   2. Темы ниже порога слабости (или худшие) помечаются «заваленными».
   3. Из заваленных собираем программу: теория (короткая + длинная) и практика.
   4. Цикл повторяется: после новой порции теста завалы пересчитываются.

   ИИ-адаптер: AIAdapter.generateProg(catId, ctx) — заглушка для будущей
   интеграции внешней LLM. Пока используется локальный генератор разнообразия
   из data.js (generators). Подключение внешнего ИИ не мешает работе.
*/

window.IQALG = (function () {

  const WEAK_THRESHOLD = 0.55;      // доля правильных ниже -> тема «слабая»
  const GOOD_THRESHOLD = 0.75;      // доля выше -> «сильная»
  const PRACTICE_PER_WEAK = 3;      // сколько вопросов практики на заваленную тему
  const THEORY_PER_WEAK = 2;        // сколько блоков теории на заваленную тему

  // Перемешать массив (Фишер-Йетс) — возвращает новый.
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Подсчёт баллов по темам из ответов на тест.
  // answers: [{ catId, correct }]
  function scoreTopics(answers) {
    const totals = {}, correct = {};
    for (const a of answers) {
      totals[a.catId] = (totals[a.catId] || 0) + 1;
      if (a.correct) correct[a.catId] = (correct[a.catId] || 0) + 1;
    }
    return Object.keys(totals).map(catId => ({
      catId,
      total: totals[catId],
      right: correct[catId] || 0,
      score: totals[catId] ? (correct[catId] || 0) / totals[catId] : 0
    }));
  }

  // Вычислить «заваленные» темы: ниже порога или, если мало данных, худшие N.
  function weakTopics(scores, minWeak = 1) {
    const scored = scores.filter(s => s.total > 0);
    if (!scored.length) return [];
    const below = scored.filter(s => s.score < WEAK_THRESHOLD);
    if (below.length >= minWeak) return below;
    // Если никто не ниже порога — берём самые слабые (minWeak тем).
    const sorted = scored.slice().sort((a, b) => a.score - b.score);
    return sorted.slice(0, minWeak);
  }

  // Общий «IQ» по всем ответам: 80 + (средний балл - 0.5) * 80, усреднённо на темы.
  function computeIQ(scores) {
    if (!scores.length) return 0;
    const avg = scores.reduce((s, x) => s + x.score, 0) / scores.length;
    return Math.max(60, Math.min(170, Math.round(80 + (avg - 0.5) * 100)));
  }

  // Собрать теорию для одной слабой темы.
  function theoryFor(catId, type = 'short', n = THEORY_PER_WEAK) {
    const blocks = window.IQDATA.THEORY[catId];
    if (!blocks) return [];
    const pool = blocks[type] || [];
    return shuffle(pool).slice(0, n);
  }

  // Собрать практику для одной слабой темы: берём из пула + генераторы разнообразия.
  function practiceFor(catId, n = PRACTICE_PER_WEAK) {
    const pool = window.IQDATA.PRACTICE[catId] || [];
    const shuffled = shuffle(pool).slice(0, Math.min(n, pool.length));
    // Дополняем сгенерированными для разнообразия, если есть генератор.
    let extra = [];
    if (window.IQDATA.generators[catId]) {
      extra = window.IQDATA.generators[catId](Math.max(0, n - shuffled.length));
    }
    return shuffle(shuffled.concat(extra));
  }

  // Собрать полную персональную программу: теория + практика по заваленным темам.
  function buildProgram(scores, opts = {}) {
    const weak = weakTopics(scores, opts.minWeak || 1);
    return weak.map(t => ({
      catId: t.catId,
      topics: {
        theoryShort: theoryFor(t.catId, 'short'),
        theoryLong: theoryFor(t.catId, 'long', 1),
        practice: practiceFor(t.catId)
      }
    }));
  }

  // ИИ-адаптер — точка интеграции внешней LLM.
  // Настраивается из app.js: IQAI.adapter = { async generateProg(catId, ctx) { ... } }
  const adapter = {
    enabled: false,
    async generateProg(catId, ctx) {
      // Заглушка: падает в локальный механизм разнообразия.
      return {
        catId,
        note: 'Теория подобрана локальным алгоритмом.',
        questions: practiceFor(catId, ctx && ctx.count || PRACTICE_PER_WEAK)
      };
    }
  };

  return {
    WEAK_THRESHOLD, GOOD_THRESHOLD,
    shuffle, scoreTopics, weakTopics, computeIQ,
    theoryFor, practiceFor, buildProgram, adapter
  };
})();