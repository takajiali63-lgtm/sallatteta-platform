// Arabic-aware text normalisation for search. Shared by the server and the browser.
// "القرعون" / "قرعون" / "القرعوْن", "أبلح" / "ابلح", "جزّين" / "جزين", "ضيعة" / "ضيعه" all match.
export function normalizeName(s, { keepAl = false } = {}) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // tashkeel + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .split(/[\s\-_.,،()/]+/)
    .map((w) => (!keepAl && w.length > 3 && w.startsWith('ال') ? w.slice(2) : w))
    .filter(Boolean)
    .join(' ');
}
