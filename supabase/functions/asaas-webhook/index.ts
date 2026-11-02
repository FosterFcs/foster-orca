// Central de pagamentos Foster: recebe os avisos do Asaas e ativa o plano no produto certo.
// Autenticação: cabeçalho 'asaas-access-token' igual ao segredo ASAAS_WEBHOOK_TOKEN (sem JWT).
// Segredos: ASAAS_WEBHOOK_TOKEN, ASAAS_API_KEY (para ler o e-mail do cliente no Asaas).
//
// Produtos atendidos: Foster Calc (tabela perfis), VistorIA (tabela vist_contas),
// Foster Orça (orca_pagamentos) e Academia Foster (acad_compras).
// Como o produto é identificado, nesta ordem:
//   0) externalReference "fosterorca:<codigo>" ou "academia:<codigo>": cobrança gerada pela função asaas-cobrar
//      para um pedido do app; confirma o pedido pelo código (não depende de e-mail);
//   1) externalReference no formato "produto:plano" (ex.: "fostercalc:pro-anual"), quando a cobrança for criada pela API;
//   2) id do link de pagamento (LINKS abaixo = final do endereço asaas.com/c/<id>);
//   3) link ainda não cadastrado aqui: só vale o valor de um plano do VistorIA (valores exclusivos dele);
//   4) valor cobrado (PLANOS abaixo), só quando a cobrança não veio de um link.
// Links de outros produtos (OUTROS_LINKS) nunca ativam plano aqui: ficam registrados como "outro_produto".
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

type Plano = { produto: string; chave: string; plano: string; dias: number; valor: number };
const PLANOS: Plano[] = [
  { produto: "fostercalc", chave: "est-mensal", plano: "estudante", dias: 31, valor: 9.9 },
  { produto: "fostercalc", chave: "est-anual", plano: "estudante", dias: 366, valor: 79 },
  { produto: "fostercalc", chave: "pro-mensal", plano: "pro", dias: 31, valor: 29.9 },
  { produto: "fostercalc", chave: "pro-anual", plano: "pro", dias: 366, valor: 299 },
  { produto: "vistoria", chave: "essencial-mensal", plano: "essencial", dias: 31, valor: 49 },
  { produto: "vistoria", chave: "essencial-anual", plano: "essencial", dias: 366, valor: 490 },
  { produto: "vistoria", chave: "profissional-mensal", plano: "profissional", dias: 31, valor: 89 },
  { produto: "vistoria", chave: "profissional-anual", plano: "profissional", dias: 366, valor: 890 },
];
// id do link de pagamento do Asaas -> "produto:chave"
const LINKS: Record<string, string> = {
  "6o5n5wj2u1r0zrdp": "fostercalc:est-mensal",
  "2hnn8c4mfn57zq2a": "fostercalc:est-anual",
  "oio2jw9yiygf6csf": "fostercalc:pro-mensal",
  "zjevnkzmkp66gzda": "fostercalc:pro-anual",
};
// links de outros produtos (tratados pelo webhook de cada um)
const OUTROS_LINKS: Record<string, string> = {
  "eqgs12tszbk96gti": "fostercentral", "1t31qz20dxatkyfv": "fostercentral",
  "yqeb9y2wx36ystu7": "fostercentral", "hlh6e4p61i29rfru": "fostercentral",
};
// pedidos dos apps (cobrança criada pela função asaas-cobrar) -> função do banco que confirma o pedido
const PEDIDOS: Record<string, { produto: string; fn: string }> = {
  fosterorca: { produto: "fosterorca", fn: "orca_confirmar_interno" },
  academia: { produto: "academia", fn: "acad_confirmar_interno" },
};

const ATIVAR = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"]);
const CANCELAR = new Set(["PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED"]);
const ok = (msg = "ok") => new Response(msg, { status: 200 });

function iguais(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// tira espaços, quebras de linha e aspas que costumam vir ao copiar e colar
const limpar = (s: string) => s.trim().replace(/^["']+|["']+$/g, "").trim();
const porValor = (valor: number, produto?: string) =>
  PLANOS.find((x) => (!produto || x.produto === produto) && Math.abs(x.valor - valor) < 0.01) || null;
function identificar(p: any, valor: number): Plano | null {
  const porChave = (ref: string) => { const [prod, chave] = ref.split(":"); return PLANOS.find((x) => x.produto === prod && x.chave === chave) || null; };
  if (typeof p.externalReference === "string" && p.externalReference.includes(":")) { const x = porChave(p.externalReference); if (x) return x; }
  if (p.paymentLink) {
    if (LINKS[p.paymentLink]) return porChave(LINKS[p.paymentLink]);
    return porValor(valor, "vistoria");   // link novo: só aceita se o valor for de um plano do VistorIA
  }
  return porValor(valor);
}
async function emailDoCliente(cliente: string): Promise<string | null> {
  const chave = limpar(Deno.env.get("ASAAS_API_KEY") || "");
  if (!chave || !cliente) return null;
  const r = await fetch(`https://api.asaas.com/v3/customers/${encodeURIComponent(cliente)}`, {
    headers: { access_token: chave, "User-Agent": "FosterCentral" },
  });
  if (!r.ok) { console.log(JSON.stringify({ diag: "api_cliente", status: r.status })); return null; }
  const c = await r.json();
  return (c?.email || "").trim() || null;
}

// funções do banco de cada produto
const FUNCOES: Record<string, { ativar: string; cancelar: string; nome: string }> = {
  fostercalc: { ativar: "ativar_plano", cancelar: "cancelar_plano_se", nome: "Foster Calc" },
  vistoria: { ativar: "vist_ativar_plano", cancelar: "vist_cancelar_se", nome: "VistorIA" },
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok();
  const esperado = limpar(Deno.env.get("ASAAS_WEBHOOK_TOKEN") || "");
  const recebido = limpar(req.headers.get("asaas-access-token") || "");
  if (!esperado || !iguais(recebido, esperado)) {
    // diagnóstico sem expor o token: tamanho e 3 primeiros caracteres de cada lado
    console.log(JSON.stringify({ diag: "token_recusado", segredoExiste: !!esperado, tamSegredo: esperado.length, tamRecebido: recebido.length,
      iniSegredo: esperado.slice(0, 3), iniRecebido: recebido.slice(0, 3) }));
    return new Response("unauthorized", { status: 401 });
  }

  let ev: any = null;
  try { ev = await req.json(); } catch { return ok("ignorado"); }
  const p = ev?.payment;
  if (!ev?.id || !ev?.event || !p) return ok("ignorado");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const valor = Number(p.originalValue ?? p.value ?? 0);
  const base = { evento_id: ev.id, evento: ev.event, pagamento_id: p.id ?? null, assinatura_id: p.subscription ?? null, cliente_asaas: p.customer ?? null,
    valor, link_id: p.paymentLink ?? null, forma: p.billingType ?? null };

  // idempotência: o mesmo evento pode chegar mais de uma vez
  const ins = await sb.from("pagamentos").insert(base);
  if (ins.error) {
    if ((ins.error as any).code === "23505") return ok("duplicado");
    console.error("erro ao registrar", ins.error);
    return new Response("erro", { status: 500 });
  }
  const marcar = (campos: Record<string, unknown>) => sb.from("pagamentos").update(campos).eq("evento_id", ev.id);

  try {
    if (p.paymentLink && OUTROS_LINKS[p.paymentLink]) { await marcar({ produto: OUTROS_LINKS[p.paymentLink], status: "outro_produto" }); return ok(); }

    // pedidos criados pela função asaas-cobrar: "fosterorca:<codigo>" ou "academia:<codigo>"
    const ref = typeof p.externalReference === "string" ? p.externalReference : "";
    const pedido = ref.includes(":") ? PEDIDOS[ref.slice(0, ref.indexOf(":"))] : undefined;
    if (pedido) {
      const codigo = ref.slice(ref.indexOf(":") + 1);
      if (CANCELAR.has(ev.event)) {
        await marcar({ produto: pedido.produto, plano: codigo, status: "estorno_revisar", detalhe: `estorno do pedido ${codigo}: revise no painel do app` });
        return ok();
      }
      if (!ATIVAR.has(ev.event)) { await marcar({ produto: pedido.produto, plano: codigo, status: "ignorado" }); return ok(); }
      const r = await sb.rpc(pedido.fn, { p_codigo: codigo, p_valor: valor });
      const st = r.error ? "erro" : (r.data?.status === "ja_pago" ? "ja_processado" : (r.data?.status ?? "erro"));
      await marcar({ produto: pedido.produto, plano: codigo, status: st, detalhe: r.error?.message ?? JSON.stringify(r.data).slice(0, 300) });
      return ok();
    }

    if (!ATIVAR.has(ev.event) && !CANCELAR.has(ev.event)) { await marcar({ status: "ignorado" }); return ok(); }
    const pl = identificar(p, valor);
    const produto = pl?.produto ?? null;

    const email = await emailDoCliente(p.customer);
    if (!email) { await marcar({ produto, status: "sem_email", detalhe: "não foi possível ler o e-mail do cliente no Asaas (confira ASAAS_API_KEY)" }); return ok(); }

    if (!pl) { await marcar({ email, status: "valor_desconhecido", detalhe: `valor ${valor} ou link ${p.paymentLink ?? "-"} não corresponde a nenhum plano` }); return ok(); }
    const fn = FUNCOES[pl.produto];
    if (!fn) { await marcar({ email, produto, plano: pl.plano, dias: pl.dias, status: "outro_produto" }); return ok(); }

    if (CANCELAR.has(ev.event)) {
      // só cancela se o plano ativo for o mesmo do pagamento estornado
      const r = await sb.rpc(fn.cancelar, { p_email: email, p_plano: pl.plano });
      const st = r.data ?? "erro";
      await marcar({ email, produto, plano: pl.plano, status: st,
        detalhe: r.error?.message ?? (st === "mantido" ? "estorno de um plano diferente do ativo: conta mantida" : null) });
      return ok();
    }

    // cartão gera CONFIRMED e depois RECEIVED para a mesma cobrança: ativa só uma vez
    if (p.id) {
      const ja = await sb.from("pagamentos").select("evento_id").eq("pagamento_id", p.id).in("status", ["ativado", "sem_conta"]).limit(1);
      if (ja.data && ja.data.length) { await marcar({ email, produto, status: "ja_processado" }); return ok(); }
    }

    const r = await sb.rpc(fn.ativar, { p_email: email, p_plano: pl.plano, p_dias: pl.dias });
    if (r.error) { await marcar({ email, produto, plano: pl.plano, dias: pl.dias, status: "erro", detalhe: r.error.message }); return ok(); }
    await marcar({ email, produto, plano: pl.plano, dias: pl.dias, status: r.data ? "ativado" : "sem_conta",
      detalhe: r.data ? `válido até ${r.data}` : `e-mail ainda sem cadastro no ${fn.nome}: ativa sozinho quando a conta for criada com esse e-mail` });
    return ok();
  } catch (e) {
    await marcar({ status: "erro", detalhe: String(e).slice(0, 300) });
    return ok();
  }
});
