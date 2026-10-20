import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/current";
import { can } from "@/lib/permissions";
import { levels, history, listProducts, listWarehouses, REASON_FR } from "@/lib/inventory";
import { productAction, warehouseAction, movementAction, transferAction } from "./actions";
const nf = new Intl.NumberFormat("fr-FR");
const R: Record<string, string> = { ...REASON_FR, TRANSFER_IN: "Transfert (entrée)", TRANSFER_OUT: "Transfert (sortie)" };

export default async function Inventory({ searchParams }: { searchParams: Promise<{ e?: string; ok?: string }> }) {
  const { ctx } = await requireUser();
  if (!can(ctx.role, "inventory", "view")) redirect("/dashboard");
  const { e, ok } = await searchParams, edit = can(ctx.role, "inventory", "create");
  const [lv, hist, prods, whs] = await Promise.all([levels(ctx), history(ctx), listProducts(ctx), listWarehouses(ctx)]);
  const P = <>{prods.map(p => <option key={p.id} value={p.id}>{p.code} – {p.name}</option>)}</>, W = <>{whs.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</>;
  return (<><h1>Stocks et approvisionnements</h1>
    {e && <div className="msg e" role="alert">{e}</div>}{ok && <div className="msg o" role="status">{ok}</div>}
    <div className="card tw"><h2>Niveaux de stock</h2>
      {lv.length === 0 ? <p>Aucun produit. {edit ? "Créez un entrepôt puis un produit ci-dessous." : ""}</p> :
      <table><thead><tr><th>Code</th><th>Désignation</th><th className="num">Quantité</th><th className="num">Seuil</th><th>Répartition</th><th>État</th></tr></thead><tbody>
        {lv.map(l => <tr key={l.id}><td>{l.code}</td><td>{l.name}</td><td className="num">{nf.format(Number(l.total))} {l.unit}</td><td className="num">{nf.format(Number(l.min_stock))}</td>
          <td>{l.byWarehouse.map(b => `${b.warehouse} : ${nf.format(Number(b.qty))}`).join(" · ") || "–"}</td>
          <td><span className={"tag " + (l.low ? "d" : "")}>{l.low ? "Stock bas" : "Suffisant"}</span></td></tr>)}</tbody></table>}</div>
    {edit && <>
      <div className="card"><h2>Mouvement de stock</h2>
        <form action={movementAction} className="row"><input type="hidden" name="key" value={randomUUID()} />
          <select name="product" required aria-label="Produit">{P}</select><select name="warehouse" required aria-label="Entrepôt">{W}</select>
          <select name="reason" aria-label="Motif">{Object.entries(REASON_FR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input name="qty" inputMode="numeric" placeholder="Quantité" required aria-label="Quantité" style={{ width: 110 }} />
          <input name="note" placeholder="Note / justification" aria-label="Note" style={{ minWidth: 220 }} /><button className="pr" type="submit">Enregistrer</button></form></div>
      <div className="card"><h2>Transfert entre entrepôts</h2>
        <form action={transferAction} className="row"><input type="hidden" name="key" value={randomUUID()} />
          <select name="product" required aria-label="Produit">{P}</select><select name="from" required aria-label="De">{W}</select><select name="to" required aria-label="Vers">{W}</select>
          <input name="qty" inputMode="numeric" placeholder="Quantité" required aria-label="Quantité" style={{ width: 110 }} /><button className="pr" type="submit">Transférer</button></form></div>
      <div className="grid">
        <div className="card"><h2>Nouvel entrepôt</h2><form action={warehouseAction} className="row"><input name="name" placeholder="Nom" required aria-label="Nom" /><input name="location" placeholder="Ville / lieu" aria-label="Lieu" /><button className="pr" type="submit">Créer</button></form></div>
        <div className="card"><h2>Nouveau produit</h2><form action={productAction} className="row"><input name="code" placeholder="Code" required aria-label="Code" style={{ width: 90 }} /><input name="name" placeholder="Désignation" required aria-label="Désignation" /><input name="unit" placeholder="Unité" aria-label="Unité" style={{ width: 80 }} /><input name="min" inputMode="numeric" placeholder="Seuil" aria-label="Seuil d’alerte" style={{ width: 80 }} /><button className="pr" type="submit">Créer</button></form></div></div></>}
    <div className="card tw"><h2>Historique des mouvements</h2>
      {hist.length === 0 ? <p>Aucun mouvement enregistré.</p> : <table><thead><tr><th>Date</th><th>Produit</th><th>Entrepôt</th><th className="num">Quantité</th><th>Motif</th><th>Note</th><th>Utilisateur</th></tr></thead><tbody>
        {hist.map((h, i) => <tr key={i}><td>{h.at}</td><td>{h.code} – {h.product}</td><td>{h.warehouse}</td><td className="num">{Number(h.quantity) > 0 ? "+" : "−"}{nf.format(Math.abs(Number(h.quantity)))}</td><td>{R[h.reason]}</td><td>{h.note ?? ""}</td><td>{h.by}</td></tr>)}</tbody></table>}</div></>);
}
