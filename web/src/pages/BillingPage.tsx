import React, { useEffect, useState } from 'react';
import { useAuth } from '../lib/useAuth';
import {
  usePlans,
  useSpotRate,
  useInvoices,
  useLedgerAuthGuard,
  useCheckout,
  useSettleInvoice,
  useSaveBillingProfile,
} from '../hooks/useLedger';
import { formatDateTime } from '../lib/format';
import { CopyInline } from '../components/CopyInline';
import { Dialog } from '../components/Dialog';

export default function BillingPage() {
  const { account } = useAuth();
  const { data: plans = [] } = usePlans();
  const { data: spotRate = 3.0 } = useSpotRate();
  const {
    data: invoices = [],
    isLoading: loading,
    error: invoicesError,
    refetch: refetchInvoices,
  } = useInvoices();
  useLedgerAuthGuard([invoicesError]);
  const checkoutMut = useCheckout();
  const settleMut = useSettleInvoice();
  const saveProfileMut = useSaveBillingProfile();
  const loadError =
    invoicesError && (invoicesError as any)?.status !== 401
      ? (invoicesError as any).message || 'Failed to load billing.'
      : null;
  const [companyName, setCompanyName] = useState(account?.tenant?.uk_company_name || '');
  const [vatNumber, setVatNumber] = useState(account?.tenant?.uk_vat_number || '');
  const [notice, setNotice] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  const [settleInvoice, setSettleInvoice] = useState<any | null>(null);
  const [settleTxid, setSettleTxid] = useState('');
  const [settleError, setSettleError] = useState<string | null>(null);

  useEffect(() => {
    if (notice && notice.tone !== 'error') {
      const timer = window.setTimeout(() => setNotice(null), 3000);
      return () => window.clearTimeout(timer);
    }
  }, [notice]);

  const checkout = async (planId: string, rail: 'veruspay' | 'stripe_gbp') => {
    setNotice(null);
    try {
      const r: any = await checkoutMut.mutateAsync({ planId, paymentRail: rail });
      if (r.upgraded) {
        setNotice({ text: `Active plan set to ${r.plan.name}`, tone: 'success' });
      } else {
        setNotice({
          text: `Issued UK VAT Invoice ${r.invoice.invoice_number}: ${r.ukTaxSummary.totalIncVatGbp} (inc 20% VAT) / ${r.invoice.amount_vrsc} VRSC`,
          tone: 'success',
        });
      }
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    }
  };

  const handleSettleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettleError(null);
    const txid = settleTxid.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      setSettleError('A valid 64-character hexadecimal Verus transaction ID (txid) is required.');
      return;
    }
    if (!settleInvoice) return;
    try {
      const r: any = await settleMut.mutateAsync({ invoiceId: settleInvoice.invoice_id, txid });
      setSettleInvoice(null);
      setSettleTxid('');
      setNotice({
        text: `Invoice ${r.invoice?.invoice_number || settleInvoice.invoice_number} settled. Provisioned ${r.plan?.name || settleInvoice.plan_id}.`,
        tone: 'success',
      });
    } catch (err: any) {
      setSettleError(err.message || 'Settlement verification failed.');
    }
  };

  const saveProfile = async () => {
    setNotice(null);
    try {
      await saveProfileMut.mutateAsync({
        ukCompanyName: companyName,
        ukVatNumber: vatNumber,
        billingCountry: 'GB',
      });
      setNotice({ text: 'Updated UK VAT entity profile', tone: 'success' });
    } catch (e: any) {
      setNotice({ text: e.message, tone: 'error' });
    }
  };

  return (
    <div className="space-y-4 font-mono text-xs tabular-nums" aria-busy={loading}>
      {loading && (
        <div className="border border-[#22262E] bg-[#111317] px-3 py-2 text-[#9CA3AF]" role="status">
          Loading plans and invoices…
        </div>
      )}
      {loadError && !loading && (
        <div className="border border-red-800 bg-[#181B20] px-3 py-2 text-red-400 flex flex-wrap items-center justify-between gap-2" role="alert">
          <span>Billing failed to load: {loadError}</span>
          <button type="button" onClick={() => void refetchInvoices()} className="px-2 py-0.5 border border-red-800 hover:border-red-400 cursor-pointer">
            Retry
          </button>
        </div>
      )}
      {/* Status Modal Overlay */}
      <Dialog
        open={notice !== null}
        tone={notice?.tone === 'error' ? 'error' : 'success'}
        label={notice?.tone === 'error' ? 'Error' : 'Success'}
        onClose={() => setNotice(null)}
      >
        {notice && (
          <>
            <div className="flex items-start gap-2.5">
              <span className="text-lg leading-none" aria-hidden="true">
                {notice.tone === 'error' ? '✕' : '✓'}
              </span>
              <span className="leading-relaxed">{notice.text}</span>
            </div>
            {notice.tone !== 'error' && (
              <div className="mt-3 text-[10px] text-[#6B7280]">
                This message will auto-dismiss in 3 seconds.
              </div>
            )}
          </>
        )}
      </Dialog>

      {/* Settle Invoice Modal */}
      <Dialog
        open={settleInvoice !== null}
        label="Settle VerusPay Invoice"
        onClose={() => {
          setSettleInvoice(null);
          setSettleTxid('');
          setSettleError(null);
        }}
      >
        {settleInvoice && (
          <form onSubmit={handleSettleSubmit} className="space-y-4">
            <div>
              <h3 className="text-sm font-bold text-[#F3F4F6]">
                Settle Invoice {settleInvoice.invoice_number}
              </h3>
              <p className="text-[11px] text-[#9CA3AF] mt-1">
                Enter the on-chain transaction ID (txid) confirming your payment of{' '}
                <span className="text-[#10B981] font-bold">
                  {settleInvoice.amount_vrsc} VRSC
                </span>{' '}
                to <span className="text-[#F3F4F6] font-mono">{settleInvoice.receiving_identity}</span>.
              </p>
            </div>

            {settleError && (
              <div className="p-2 border border-red-800 bg-[#181B20] text-red-400 text-[11px]" role="alert">
                {settleError}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="settle-txid" className="block text-[11px] font-bold text-[#F3F4F6] uppercase">
                Verus Transaction ID (txid)
              </label>
              <input
                id="settle-txid"
                type="text"
                value={settleTxid}
                onChange={(e) => setSettleTxid(e.target.value)}
                placeholder="64-character hexadecimal transaction ID..."
                className="w-full bg-[#090A0C] border border-[#22262E] px-3 py-1.5 text-xs text-[#F3F4F6] font-mono focus:border-[#10B981] focus:outline-none"
                autoFocus
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[#22262E]">
              <button
                type="button"
                onClick={() => {
                  setSettleInvoice(null);
                  setSettleTxid('');
                  setSettleError(null);
                }}
                className="px-3 py-1 border border-[#22262E] text-[#9CA3AF] hover:text-[#F3F4F6] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={settleMut.isPending}
                className="px-3 py-1 bg-[#10B981] text-[#090A0C] font-bold cursor-pointer disabled:opacity-50"
              >
                {settleMut.isPending ? 'Verifying on-chain…' : 'Verify & Settle'}
              </button>
            </div>
          </form>
        )}
      </Dialog>

      {/* Segmented Plan Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-[#22262E] border border-[#22262E] bg-[#111317]">
        {plans.map((p: any) => {
          const isCurrent = account?.tenant?.plan_id === p.id;
          const vatPence = Math.round(Number(p.priceGbpPence || 0) / 5);
          const totalPence = Number(p.priceGbpPence || 0) + vatPence;
          const totalIncVat = (totalPence / 100).toFixed(2);
          const isPaidPlan = Number(p.priceGbpPence || 0) > 0;
          const totalVrsc = isPaidPlan ? (Math.round((totalPence / 100 / spotRate) * 1e8) / 1e8).toFixed(4) : '0.0000';
          return (
            <div key={p.id} className="p-4 flex flex-col justify-between space-y-4">
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-[#F3F4F6] uppercase">{p.name}</span>
                  {isCurrent ? (
                    <span className="px-1.5 py-0.5 bg-[#10B981]/15 text-[#10B981] border border-[#10B981]/40 text-[10px]">
                      ACTIVE
                    </span>
                  ) : (
                    <span className="text-[10px] text-[#6B7280]">{p.chainScope}</span>
                  )}
                </div>

                <div className="border-y border-[#22262E] py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xl font-bold text-[#F3F4F6]">{p.priceGbpDisplay}</span>
                    <span className="text-[11px] text-[#6B7280]">
                      / mo {p.priceGbpPence > 0 ? `(ex VAT · £${totalIncVat} inc 20% UK VAT)` : ''}
                    </span>
                  </div>
                  <div className="text-[11px] text-[#10B981] mt-0.5">
                    {Number(p.priceGbpPence || 0) > 0 ? `${totalVrsc} VRSC / mo (spot £${Number(spotRate).toFixed(2)}/VRSC)` : '0.0000 VRSC (Testnet quota)'}
                  </div>
                </div>

                <ul className="space-y-1 text-[11px] text-[#9CA3AF]">
                  {(p.features || []).map((f: string, i: number) => (
                    <li key={i}>+ {f}</li>
                  ))}
                </ul>
              </div>

              <div className="grid grid-cols-2 gap-1.5 pt-2">
                <button
                  type="button"
                  onClick={() => checkout(p.id, 'veruspay')}
                  className="py-1.5 px-2 bg-[#10B981] text-[#090A0C] font-semibold text-xs cursor-pointer"
                >
                  {p.priceGbpPence === 0 ? 'Select Free' : 'VerusPay (VRSC)'}
                </button>
                {p.priceGbpPence > 0 && (
                  <button
                    type="button"
                    onClick={() => checkout(p.id, 'stripe_gbp')}
                    className="py-1.5 px-2 bg-[#090A0C] border border-[#22262E] hover:border-[#F3F4F6] text-[#F3F4F6] text-xs cursor-pointer"
                  >
                    Stripe UK (£)
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom Ledger: UK Entity Settings + Invoices Table */}
      <div className="grid grid-cols-1 lg:grid-cols-12 border border-[#22262E] bg-[#111317] divide-y lg:divide-y-0 lg:divide-x divide-[#22262E]">
        <div className="lg:col-span-4 p-3.5 space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-[#9CA3AF] border-b border-[#22262E] pb-2">
            UK VAT Entity Registration (HMRC)
          </div>
          <div>
            <label className="block text-[10px] uppercase text-[#6B7280] mb-1" htmlFor="billing-company">
              Registered Legal Name
            </label>
            <input
              id="billing-company"
              value={companyName}
              autoComplete="organization"
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="VREAL Sovereign Labs Ltd"
              className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase text-[#6B7280] mb-1" htmlFor="billing-vat">
              UK VAT Number (GB...)
            </label>
            <input
              id="billing-vat"
              value={vatNumber}
              autoComplete="off"
              inputMode="text"
              onChange={(e) => setVatNumber(e.target.value)}
              placeholder="GB123456789"
              className="w-full bg-[#090A0C] border border-[#22262E] px-2.5 py-1.5 text-xs text-[#F3F4F6]"
            />
          </div>
          <button
            type="button"
            onClick={saveProfile}
            className="w-full py-1.5 px-3 bg-[#181B20] border border-[#22262E] hover:border-[#10B981] text-[#F3F4F6] cursor-pointer"
          >
            Save Entity Profile
          </button>
        </div>

        <div className="lg:col-span-8 flex flex-col">
          <div className="px-3.5 py-2 border-b border-[#22262E] bg-[#090A0C] flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-[#9CA3AF]">
              Tax &amp; VerusPay Settlement Ledger ({invoices.length})
            </span>
            <span className="text-[10px] text-[#6B7280]">Supplier: SovPin Technologies Ltd (GB)</span>
          </div>

          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left border-collapse">
            <thead>
              <tr className="border-b border-[#22262E] bg-[#090A0C]/50 text-[10px] uppercase text-[#6B7280]">
                <th scope="col" className="py-1.5 px-3">Invoice #</th>
                <th scope="col" className="py-1.5 px-3">Plan</th>
                <th scope="col" className="py-1.5 px-3 text-right">Net (£)</th>
                <th scope="col" className="py-1.5 px-3 text-right">VAT 20%</th>
                <th scope="col" className="py-1.5 px-3 text-right">Total (£ / VRSC)</th>
                <th scope="col" className="py-1.5 px-3">Status</th>
                <th scope="col" className="py-1.5 px-3 text-right">Settlement</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#22262E]">
              {invoices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 px-3 text-center text-[#6B7280]">
                    No invoices issued.
                  </td>
                </tr>
              ) : (
                invoices.map((inv: any) => {
                  const sub = (inv.subtotal_gbp_pence / 100).toFixed(2);
                  const vat = (inv.vat_gbp_pence / 100).toFixed(2);
                  const tot = (inv.total_gbp_pence / 100).toFixed(2);
                  const sendCmd = `verus -chain=VRSCTEST sendcurrency "*" '[{"address":"${inv.receiving_identity}","amount":${inv.amount_vrsc},"memo":"${inv.veruspay_memo}"}]'`;
                  return (
                    <tr key={inv.invoice_id} className="hover:bg-[#16191F]">
                      <td className="py-1.5 px-3 text-[#F3F4F6]">{inv.invoice_number}</td>
                      <td className="py-1.5 px-3 uppercase text-[#9CA3AF]">{inv.plan_id}</td>
                      <td className="py-1.5 px-3 text-right text-[#9CA3AF]">£{sub}</td>
                      <td className="py-1.5 px-3 text-right text-[#9CA3AF]">£{vat}</td>
                      <td className="py-1.5 px-3 text-right">
                        <span className="text-[#F3F4F6] font-bold">£{tot}</span>{' '}
                        <span className="text-[#10B981]">({inv.amount_vrsc} VRSC)</span>
                      </td>
                      <td className="py-1.5 px-3">
                        <span
                          className={
                            inv.status === 'paid' ? 'text-[#10B981]' : 'text-[#F97316]'
                          }
                        >
                          ● {inv.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        {inv.status === 'open' ? (
                          <div className="inline-flex items-center gap-2">
                            <CopyInline value={sendCmd} label="CLI" />
                            <button
                              type="button"
                              onClick={() => {
                                setSettleInvoice(inv);
                                setSettleTxid('');
                                setSettleError(null);
                              }}
                              className="px-2 py-0.5 bg-[#10B981] text-[#090A0C] font-bold cursor-pointer"
                            >
                              Settle
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-[#6B7280]">
                            {formatDateTime(inv.paid_at)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  );
}
