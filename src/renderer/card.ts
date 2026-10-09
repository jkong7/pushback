interface CardData {
  merchant: string;
  result: string;
  summary: string;
  old: number | null;
  now: number | null;
  credit: number;
  months: number | null;
  minutes: number;
  hold: number;
  quote: string;
}

const d = JSON.parse(decodeURIComponent(location.hash.slice(1))) as CardData;
const el = (tag: string, cls: string, text = "") => {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
};
const root = document.getElementById("card")!;
root.className = "share-card";
const headline =
  d.result === "cancelled"
    ? `Cancelled ${d.merchant}. No retention guilt trip, no hold music.`
    : d.credit && d.now == null
      ? `Got $${d.credit} back from ${d.merchant}.`
      : d.old != null && d.now != null
        ? `$${(d.old - d.now).toFixed(0)} a month off ${d.merchant}.`
        : d.summary;
root.append(el("div", "sc-brand", "Pushback"));
root.append(el("div", "sc-head", headline));
if (d.old != null && d.now != null && d.now < d.old) {
  const row = el("div", "sc-prices");
  row.append(el("span", "sc-old", `$${d.old}`), el("span", "sc-arrow", "→"), el("span", "sc-new", `$${d.now}`));
  root.append(row);
  root.append(el("div", "sc-sub", `${d.months ? `for ${d.months} months, ` : ""}$${((d.old - d.now) * Math.min(12, d.months ?? 12)).toFixed(0)} saved this year`));
}
if (d.quote) root.append(el("div", "sc-quote", `"${d.quote.replace(/\{\{[a-z0-9_]+\}\}/g, "...")}"`));
root.append(el("div", "sc-foot", `My AI made the call. ${d.minutes} min${d.hold ? `, ${d.hold} on hold` : ""}. I didn't pick up the phone.`));
