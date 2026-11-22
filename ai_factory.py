#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""IQuit — фабрика вопросов через локальную Ollama.
Генерит вопросы по 6 темам, валидирует (правильный ответ в списке вариантов),
и печатает JSON-массив для вставки в data.js как AI_POOL.

Запуск:  python3 ai_factory.py [кол-во на тему]
"""
import json
import re
import sys
import urllib.request

OLLAMA = "http://127.0.0.1:11434/api/generate"
MODEL = "iqquit-qwen"     # 1.5B точнее в правильных ответах; медленнее, но это batch-генерация

TOPICS = [
    ("math",      "математику (арифметика, проценты, ряды, уравнения)"),
    ("logic",     "логику и рассуждения (силлогизмы, закономерности, ряды)"),
    ("verbal",    "вербальные способности (синонимы, антонимы, аналогии)"),
    ("spatial",   "пространственное мышление (геометрия, повороты фигур)"),
    ("memory",    "память (короткие ряды слов/чисел для запоминания)"),
    ("attention", "внимание (подсчёт букв/цифр, поиск лишнего, ошибок)"),
]

PROMPT_TMPL = """Создай РОВНО ОДИН вопрос для теста IQ на русском языке по теме: {theme}.

Выведи ТОЛЬКО блок формата ниже, без пояснений, без пустых строк внутри:
ВОПРОС: {topic_help}
A: первый вариант ответа
B: второй вариант ответа
C: третий вариант ответа
D: четвёртый вариант ответа
ОТВЕТ: буква правильного варианта

Пример правильного вывода:
ВОПРОС: Какое число пропущено в ряду 2, 4, 8, 16, ?
A: 24
B: 32
C: 20
D: 28
ОТВЕТ: B

Соблюдай: правильный ответ обязан совпадать с буквой в ОТВЕТ. Не используй эмодзи."""

# Подсказка по теме для шаблона вопроса (чтобы вопрос был содержательным)
TOPIC_HINT = {
    "math":      "задание на арифметику, проценты, числовой ряд или простое уравнение",
    "logic":     "задание на логическое рассуждение, закономерность или силлогизм",
    "verbal":    "задание на синоним, антоним или логическую аналогию со словами",
    "spatial":   "задание на геометрию или мысленный поворот простой фигуры",
    "memory":    "короткий ряд из 3-5 слов или чисел для запоминания, затем вопрос по нему",
    "attention": "задание на подсчёт повторяющихся букв/цифр в слове или строке, либо поиск лишнего",
}


def call_ollama(prompt, num_predict=512):
    data = json.dumps({
        "model": MODEL, "prompt": prompt,
        "stream": False, "options": {"num_predict": num_predict, "temperature": 0.8}
    }).encode()
    req = urllib.request.Request(OLLAMA, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        return json.load(resp).get("response", "")


def parse_questions(text, theme_id):
    """Разбираем ответ модели в список {q, options[], a, catId}.
    Модель ставит пустые строки между полями, поэтому парсим построчно,
    а новый вопрос начинается со строки 'ВОПРОС:'. Пустые строки игнорируем.
    """
    questions = []
    text = text.replace("\r", "")
    cur = None  # текущее собираемое задание {q, opts, ans}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = re.match(r"^ВОПРОС\s*[:.]\s*(.+)$", line, re.I)
        if m:
            # завершаем предыдущее
            if cur:
                parsed = _finish(cur, theme_id)
                if parsed:
                    questions.append(parsed)
            cur = {"q": m.group(1).strip(), "opts": {}, "ans": None}
            continue
        m = re.match(r"^([A-D])\s*[:.)]\s*(.+)$", line, re.I)
        if m and cur is not None:
            cur["opts"][m.group(1).upper()] = m.group(2).strip()
            continue
        m = re.match(r"^ОТВЕТ\s*[:.]?\s*([A-D])$", line, re.I)
        if m and cur is not None:
            cur["ans"] = m.group(1).upper()
    if cur:
        parsed = _finish(cur, theme_id)
        if parsed:
            questions.append(parsed)
    return questions


def _finish(cur, theme_id):
    q = cur["q"]
    opts = cur["opts"]
    ans_letter = cur["ans"]
    if not q or not opts or not ans_letter:
        return None
    if ans_letter not in opts:
        return None
    options = [opts.get(k) for k in ("A", "B", "C", "D") if opts.get(k)]
    if len(options) < 2:
        return None
    return {"catId": theme_id, "q": q, "options": options, "a": opts[ans_letter]}


def gen_one(theme_id, theme_name, attempts=4):
    """Генрим по одному вопросу с повторами, пока не словили валидный."""
    prompt = PROMPT_TMPL.format(theme=theme_name, topic_help=TOPIC_HINT[theme_id])
    for _ in range(attempts):
        try:
            resp = call_ollama(prompt, num_predict=160)
        except Exception as e:
            print(f"    ошибка запроса: {e}", file=sys.stderr, flush=True)
            continue
        parsed = parse_questions(resp, theme_id)
        if parsed:
            return parsed[0]
    return None


def main():
    per = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    if per > 12:
        sys.stderr.write("Не рекомендую больше 12 на тему — модель медленная.\n")
        per = 12
    out = []
    for theme_id, theme_name in TOPICS:
        got = 0
        while got < per:
            print(f"Генерация {theme_id} ({got+1}/{per})...", file=sys.stderr, flush=True)
            q = gen_one(theme_id, theme_name)
            if q:
                out.append(q)
                got += 1
            else:
                print(f"  (не получилось, повторю)", file=sys.stderr, flush=True)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()