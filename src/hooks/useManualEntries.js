import React, { useState } from 'react';
import { localTodayIso } from '@/lib/dates';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { formatNumber, getCurrencySymbol } from '@/lib/formatters';
import { isCashPosition } from '@/lib/positionKind';
import { createAssets } from '@/services/assetCreateService';
import {
  cashTickersForCurrency,
  canonicalCashTicker,
  findCashAssetByCurrency,
  findCashPosition,
} from '@/lib/cashIdentity';

/**
 * Manual-entry CRUD extracted from CarteraPage (fase 2 del split): the four
 * save handlers (sale/dividend/commission/cash), transaction & position
 * deletion with cash restoration, plus the shared primitives
 * ensureCashPosition and adjustPositionQty (atomic RPC).
 *
 * State and handlers keep their original names so consumers
 * (TransactionModals, PositionActionBar, history tables) are wired unchanged.
 *
 * @param {object} deps
 *   user                      authenticated user
 *   selectedBrokerId          current broker filter
 *   preferredCurrency         display currency (cash modal default)
 *   positions                 loaded positions (portfolio_id resolution + selectors)
 *   loadPositions             usePositions loader
 *   refreshLoadedTransactions re-fetches expanded per-asset transaction lists
 */
export function useManualEntries({
  user,
  selectedBrokerId,
  preferredCurrency,
  positions,
  loadPositions,
  refreshLoadedTransactions,
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  // Manual Entry Modals
  const [isAddSaleOpen, setIsAddSaleOpen] = useState(false);
  const [isAddDividendOpen, setIsAddDividendOpen] = useState(false);
  const [isAddCommissionOpen, setIsAddCommissionOpen] = useState(false);
  const [isAddCashOpen, setIsAddCashOpen] = useState(false);
  const [manualEntryLoading, setManualEntryLoading] = useState(false);

  const defaultManualSale = { id: null, positionId: '', quantity: '', price: '', commission: 0, date: localTodayIso(), notes: '' };
  const defaultManualDividend = { id: null, positionId: '', amount: '', date: localTodayIso(), notes: '' };
  const defaultManualCommission = { id: null, positionId: '', amount: '', date: localTodayIso(), description: '' };
  const defaultManualCash = { id: null, amount: '', currency: 'USD', date: localTodayIso(), description: '', type: 'DEPOSIT' };

  const [manualSale, setManualSale] = useState(defaultManualSale);
  const [manualDividend, setManualDividend] = useState(defaultManualDividend);
  const [manualCommission, setManualCommission] = useState(defaultManualCommission);
  const [manualCash, setManualCash] = useState(defaultManualCash);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [transactionToDelete, setTransactionToDelete] = useState(null);
  const [positionToDelete, setPositionToDelete] = useState(null);

  // Available positions for manual entry selectors
  const availablePositions = React.useMemo(() => {
    return positions.filter(p => p.assets && !isCashPosition(p));
  }, [positions]);

  // First cash position for linking FEE/CASH transactions
  const cashPositionId = React.useMemo(() => {
    const cashPos = positions.find(isCashPosition);
    return cashPos?.id || (positions.length > 0 ? positions[0].id : null);
  }, [positions]);

  // Atomic position-quantity adjustment via the adjust_position_quantity RPC.
  // Replaces the old SELECT quantity → compute in JS → UPDATE pattern, which lost
  // updates under concurrency (two tabs, double click, network retry).
  // Returns the new quantity after applying the delta.
  const adjustPositionQty = async (positionId, delta, minZero = false) => {
    const { data, error } = await supabase.rpc('adjust_position_quantity', {
      p_position_id: positionId,
      p_delta: delta,
      p_min_zero: minZero,
    });
    if (error) throw error;
    return parseFloat(data);
  };

  const ensureCashPosition = async (brokerId, currency = 'EUR') => {
    const cur = (currency || 'EUR').toUpperCase();
    // NEW rows keep the manual canonical form; lookups accept both aliases
    // (CASH_EUR and CASH_EUR (EUR)) via cashIdentity — never bare CASH.
    const cashTicker = canonicalCashTicker(cur);

    // 1a. Already-loaded positions for this broker (covers DeGiro-style tickers
    // that an exact assets.ticker = CASH_${cur} query would miss).
    const fromState = findCashPosition(positions, { currency: cur, brokerId });
    if (fromState?.id) return fromState.id;

    // 1b. DB: all positions of this broker with nested assets, then match with
    // trim/upper (exact .eq on ticker misses legacies like ' cash_chf ').
    {
      const { data: brokerPositions, error: brokerPositionsError } = await supabase.from('positions')
        .select('id, asset_id, broker_id, assets(id, ticker, currency, asset_class)')
        .eq('broker_id', brokerId);
      if (brokerPositionsError) throw brokerPositionsError;
      const fromDb = findCashPosition(brokerPositions || [], { currency: cur, brokerId });
      if (fromDb?.id) return fromDb.id;
    }

    // 2. Identify Portfolio ID
    let portfolioId = positions[0]?.portfolio_id;
    if (!portfolioId) {
      const { data: anyPos } = await supabase.from('positions').select('portfolio_id').limit(1).maybeSingle();
      portfolioId = anyPos?.portfolio_id;
      if (!portfolioId) {
        const { data: p } = await supabase.from('portfolios').select('id').eq('user_id', user.id).limit(1).maybeSingle();
        portfolioId = p?.id;
      }
    }

    // 3. Ensure cash asset exists for this currency (reuse canonical aliases
    // only — CASH_EUR / CASH_EUR (EUR)). Exact .eq first, then optional
    // class+currency candidates filtered by findCashAssetByCurrency (R2:
    // non-canonical tickers never match).
    let cashAsset = null;
    const assetCandidates = [];
    for (const ticker of cashTickersForCurrency(cur)) {
      const { data: cashAssets } = await supabase.from('assets')
        .select('id, ticker, currency, asset_class')
        .eq('ticker', ticker)
        .limit(1);
      if (cashAssets?.[0]) assetCandidates.push(cashAssets[0]);
    }
    if (assetCandidates.length === 0) {
      const { data: classHits, error: classHitsError } = await supabase.from('assets')
        .select('id, ticker, currency, asset_class')
        .eq('currency', cur)
        .ilike('asset_class', 'cash');
      if (classHitsError) throw classHitsError;
      for (const a of classHits || []) assetCandidates.push(a);
    }
    if (assetCandidates.length > 0) {
      const byTicker = Object.fromEntries(assetCandidates.map((a) => [a.ticker, a]));
      cashAsset = findCashAssetByCurrency(byTicker, cur);
    }
    if (!cashAsset) {
      const [newAsset] = await createAssets([{
        ticker: cashTicker,
        company_name: `Cash / Liquidity (${cur})`,
        asset_class: 'Cash',
        currency: cur,
        current_price: 1
      }]);
      cashAsset = newAsset;
    }

    // 4. Reuse position for this broker+asset before inserting (vista combinada:
    // deleting a sale on broker B must not create a second CHF row).
    {
      const { data: existingByAsset, error: existingByAssetError } = await supabase.from('positions')
        .select('id')
        .eq('broker_id', brokerId)
        .eq('asset_id', cashAsset.id)
        .maybeSingle();
      if (existingByAssetError) throw existingByAssetError;
      if (existingByAsset?.id) return existingByAsset.id;
    }

    const { data: newPos, error: newPosError } = await supabase.from('positions').insert({
      portfolio_id: portfolioId,
      broker_id: brokerId,
      asset_id: cashAsset.id,
      quantity: 0,
      entry_price: 1,
      custom_classification: 'Cash'
    }).select().single();
    if (newPosError) throw newPosError;

    return newPos?.id;
  };

  const handleSaveManualSale = async () => {
    if (!manualSale.positionId || !manualSale.quantity || !manualSale.price) return;
    const selectedPos = availablePositions.find(p => p.id === manualSale.positionId);
    const availableQty = parseFloat(selectedPos?.quantity || 0);
    const sellQty = parseFloat(manualSale.quantity || 0);

    // If updating, we need to account for the quantity already "sold" in this transaction
    let adjustedAvailableQty = availableQty;
    let currentOldQty = 0;
    if (manualSale.id) {
      const { data: oldTrans } = await supabase.from('transactions').select('quantity').eq('id', manualSale.id).single();
      if (oldTrans) {
        currentOldQty = parseFloat(oldTrans.quantity || 0);
        adjustedAvailableQty += currentOldQty;
      }
    }

    if (sellQty <= 0) {
      toast({ variant: 'destructive', title: t('common.error_validation'), description: t('cartera.error_qty_zero') });
      return;
    }

    if (sellQty > adjustedAvailableQty) {
      toast({ variant: 'destructive', title: t('common.error_validation'), description: t('cartera.error_sell_excess', { n: adjustedAvailableQty }) });
      return;
    }

    setManualEntryLoading(true);
    try {
      const transactionData = {
        position_id: manualSale.positionId,
        transaction_type: 'SELL',
        quantity: sellQty,
        price: parseFloat(manualSale.price),
        total_amount: sellQty * parseFloat(manualSale.price),
        transaction_date: `${manualSale.date}T00:00:00`,
        notes: manualSale.notes || 'Venta registrada manualmente'
      };

      let response;
      if (manualSale.id) {
        response = await supabase.from('transactions').update(transactionData).eq('id', manualSale.id).select();
      } else {
        response = await supabase.from('transactions').insert(transactionData).select();
      }

      if (response.error) throw response.error;
      if (manualSale.id && (!response.data || response.data.length === 0)) {
        throw new Error('Supabase actualizó 0 filas de venta. ¿Tienes permisos?');
      }

      // Automatically update the quantity in the positions table (atomic delta)
      const { data: currentPos } = await supabase.from('positions')
        .select('assets(company_name, ticker, currency), broker_id')
        .eq('id', manualSale.positionId)
        .single();

      await adjustPositionQty(manualSale.positionId, currentOldQty - sellQty, true);

      if (currentPos) {
        // Cash Sync: Add sale proceeds (less commission) to Cash position in the asset's currency
        const saleCurrency = currentPos.assets?.currency || 'EUR';
        const cashPosId = await ensureCashPosition(currentPos.broker_id, saleCurrency);
        if (cashPosId) {
          const oldTotal = currentOldQty * parseFloat(manualSale.price); // Approximation for simplicity
          const newTotal = sellQty * parseFloat(manualSale.price);
          const commAmt = parseFloat(manualSale.commission || 0);

          let cashDelta = newTotal - oldTotal;
          if (!manualSale.id) cashDelta -= commAmt; // Only subtract commission on new entries

          await adjustPositionQty(cashPosId, cashDelta);
        }
      }

      // Handle commission (FEE) - simplified: we don't track the specific FEE linked to a SALE for editing yet,
      // but user can edit the FEE manually in the Commissions table now.
      const commAmount = parseFloat(manualSale.commission);
      if (commAmount > 0 && !manualSale.id) { // Only auto-create fee on new sales to avoid duplicates on edit
        const assetName = currentPos?.assets?.company_name || currentPos?.assets?.ticker || '';
        await supabase.from('transactions').insert({
          position_id: manualSale.positionId,
          transaction_type: 'FEE',
          quantity: 0,
          price: 0,
          total_amount: -Math.abs(commAmount),
          transaction_date: `${manualSale.date}T00:00:00`,
          notes: `Comisión de venta (${assetName}): ${manualSale.notes || ''}`
        });
      }

      toast({ title: manualSale.id ? t('cartera.sale_updated') : t('cartera.sale_saved') });
      setIsAddSaleOpen(false);
      setManualSale(defaultManualSale);
      await loadPositions(selectedBrokerId);
      await refreshLoadedTransactions();
    } catch (err) {
      toast({ variant: 'destructive', title: t('common.error_save'), description: err.message + (err.details ? ': ' + err.details : '') });
    } finally { setManualEntryLoading(false); }
  };

  const handleSaveManualDividend = async () => {
    if (!manualDividend.positionId || !manualDividend.amount) return;
    setManualEntryLoading(true);
    try {
      const transData = {
        position_id: manualDividend.positionId,
        transaction_type: 'DIVIDEND',
        quantity: 0,
        price: 0,
        total_amount: parseFloat(manualDividend.amount),
        transaction_date: `${manualDividend.date}T00:00:00`,
        notes: manualDividend.notes || 'Dividendo registrado manualmente'
      };

      const { data: old, error: fetchOldError } = manualDividend.id ? await supabase.from('transactions').select('total_amount').eq('id', manualDividend.id).single() : { data: null };
      const oldAmount = parseFloat(old?.total_amount || 0);

      let response;
      if (manualDividend.id) {
        response = await supabase.from('transactions').update(transData).eq('id', manualDividend.id).select();
      } else {
        response = await supabase.from('transactions').insert(transData).select();
      }

      if (response.error) throw response.error;
      if (manualDividend.id && (!response.data || response.data.length === 0)) {
        throw new Error('Supabase actualizó 0 filas. ¿Tienes permisos?');
      }

      // Cash Sync
      const { data: pos } = await supabase.from('positions').select('broker_id, assets(currency)').eq('id', manualDividend.positionId).single();
      const divCurrency = pos?.assets?.currency || 'EUR';
      const cashPosId = await ensureCashPosition(pos?.broker_id, divCurrency);
      if (cashPosId) {
        await adjustPositionQty(cashPosId, transData.total_amount - oldAmount);
      }

      toast({ title: manualDividend.id ? t('cartera.dividend_updated') : t('cartera.dividend_saved') });
      setIsAddDividendOpen(false);
      setManualDividend(defaultManualDividend);

      await loadPositions(selectedBrokerId);
      await refreshLoadedTransactions();
    } catch (err) {
      toast({ variant: 'destructive', title: t('common.error_save'), description: err.message + (err.details ? ': ' + err.details : '') });
    } finally { setManualEntryLoading(false); }
  };

  const handleSaveManualCommission = async () => {
    if (!manualCommission.amount) return;
    setManualEntryLoading(true);
    try {
      let posId = manualCommission.positionId || cashPositionId;
      if (!posId && selectedBrokerId !== 'general') posId = await ensureCashPosition(selectedBrokerId);
      if (!posId) { toast({ variant: 'destructive', title: t('common.error'), description: t('cartera.error_no_position') }); return; }

      const transData = {
        position_id: posId,
        transaction_type: 'FEE',
        quantity: 0,
        price: 0,
        total_amount: -Math.abs(parseFloat(manualCommission.amount)),
        transaction_date: `${manualCommission.date}T00:00:00`,
        notes: manualCommission.description || 'Comisión registrada manualmente'
      };

      const { data: old, error: fetchOldError } = manualCommission.id ? await supabase.from('transactions').select('total_amount').eq('id', manualCommission.id).single() : { data: null };
      const oldAmount = parseFloat(old?.total_amount || 0); // Note: FEES are negative in DB usually, let's see

      let response;
      if (manualCommission.id) {
        response = await supabase.from('transactions').update(transData).eq('id', manualCommission.id).select();
      } else {
        response = await supabase.from('transactions').insert(transData).select();
      }

      if (response.error) throw response.error;
      if (manualCommission.id && (!response.data || response.data.length === 0)) {
        throw new Error('Supabase actualizó 0 filas de comisión. ¿Tienes permisos?');
      }

      // Cash Sync
      const cashPosIdForComm = await ensureCashPosition(selectedBrokerId);
      if (cashPosIdForComm) {
        await adjustPositionQty(cashPosIdForComm, transData.total_amount - oldAmount);
      }

      toast({ title: manualCommission.id ? t('cartera.commission_updated') : t('cartera.commission_saved') });
      setIsAddCommissionOpen(false);
      setManualCommission(defaultManualCommission);
      await loadPositions(selectedBrokerId);
      await refreshLoadedTransactions();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: t('common.error_save'),
        description: err.message + (err.details ? ': ' + err.details : '')
      });
    } finally { setManualEntryLoading(false); }
  };

  const handleSaveManualCash = async () => {
    if (!manualCash.amount) return;
    setManualEntryLoading(true);
    try {
      const amount = parseFloat(manualCash.amount);
      const isWithdrawal = manualCash.type === 'WITHDRAWAL';
      const currency = manualCash.currency || preferredCurrency || 'USD';

      // Resolve via ensureCashPosition (aliases + legacy spellings) — never a
      // second EUR row when the broker already has CASH_EUR (EUR).
      let posId = null;
      if (selectedBrokerId !== 'general') {
        posId = await ensureCashPosition(selectedBrokerId, currency);
      }

      if (!posId) {
        toast({ variant: 'destructive', title: t('common.error'), description: t('cartera.error_select_broker') });
        return;
      }

      const transData = {
        position_id: posId,
        transaction_type: 'CASH',
        quantity: 0,
        price: 0,
        total_amount: isWithdrawal ? -Math.abs(amount) : Math.abs(amount),
        transaction_date: `${manualCash.date}T00:00:00`,
        notes: manualCash.description || (isWithdrawal ? 'Retirada de efectivo manual' : 'Depósito de efectivo manual')
      };

      const { data: old } = manualCash.id ? await supabase.from('transactions').select('total_amount').eq('id', manualCash.id).single() : { data: null };
      const oldAmount = parseFloat(old?.total_amount || 0);

      let response;
      if (manualCash.id) {
        response = await supabase.from('transactions').update(transData).eq('id', manualCash.id).select();
      } else {
        response = await supabase.from('transactions').insert(transData).select();
      }

      if (response.error) throw response.error;

      // Cash Balance Sync in the specific Position record (atomic delta, returns new balance)
      const newCash = await adjustPositionQty(posId, transData.total_amount - oldAmount);

      toast({
        title: manualCash.id ? t('cartera.cash_updated') : t('cartera.cash_saved'),
        description: t('cartera.cash_new_balance', { sym: getCurrencySymbol(currency), amount: formatNumber(newCash, 2, 2) })
      });
      setIsAddCashOpen(false);
      setManualCash(defaultManualCash);
      await loadPositions(selectedBrokerId);
      await refreshLoadedTransactions();
    } catch (err) {
      toast({ variant: 'destructive', title: t('common.error_save'), description: err.message });
    } finally { setManualEntryLoading(false); }
  };

  const handleDeleteTransaction = (tx) => {
    setTransactionToDelete(tx);
    setIsDeleteConfirmOpen(true);
  };

  const confirmDeleteTransaction = async () => {
    if (!transactionToDelete) return;
    // NOTE: do NOT name this `t` — it would shadow the i18n `t()` and crash the
    // success/error toasts below (which then skipped the reload, leaving the
    // history stale until a manual refresh).
    const tx = transactionToDelete;
    setIsDeleteConfirmOpen(false);
    setManualEntryLoading(true);

    try {
      const brokerId = tx.positions?.broker_id;
      const assetCurrency = tx.positions?.assets?.currency || 'EUR';

      // 1. Restore/Subtract Asset Quantity (atomic deltas)
      if (tx.transaction_type === 'SELL') {
        await adjustPositionQty(tx.position_id, parseFloat(tx.quantity) || 0);
      } else if (tx.transaction_type === 'BUY') {
        await adjustPositionQty(tx.position_id, -(parseFloat(tx.quantity) || 0), true);
      }

      // 2. Restore/Subtract Cash Balance
      // BUY transactions are NOT deducted from cash when created (handleAddPosition doesn't
      // touch cash), so deleting a BUY must never add cash back either — that would create
      // phantom balances. Only SELL/DIVIDEND/FEE/CASH actually moved cash.
      const cashAffectingTypes = ['SELL', 'DIVIDEND', 'FEE', 'CASH'];
      if (cashAffectingTypes.includes(tx.transaction_type)) {
        const cashPosId = await ensureCashPosition(brokerId, assetCurrency);
        if (cashPosId) {
          let cashDelta = 0;
          if (tx.transaction_type === 'SELL') cashDelta = -tx.total_amount;
          else if (tx.transaction_type === 'DIVIDEND') cashDelta = -tx.total_amount;
          else if (tx.transaction_type === 'FEE') cashDelta = Math.abs(tx.total_amount);
          else if (tx.transaction_type === 'CASH') cashDelta = -tx.total_amount;

          if (cashDelta !== 0) {
            await adjustPositionQty(cashPosId, cashDelta);
          }
        }
      }

      // 3. For SELL transactions: cascade-delete associated FEE (commission) records
      //    created automatically when the sale was saved. Identify them by:
      //    same position_id + same date prefix + notes containing "Comisión de venta".
      //    Also restore their commission amount to cash (was baked into the SELL cash update).
      if (tx.transaction_type === 'SELL') {
        const sellDatePrefix = (tx.transaction_date || '').split('T')[0];
        const { data: linkedFees } = await supabase
          .from('transactions')
          .select('id, total_amount')
          .eq('position_id', tx.position_id)
          .eq('transaction_type', 'FEE')
          .like('notes', 'Comisión de venta%')
          .gte('transaction_date', `${sellDatePrefix}T00:00:00`)
          .lte('transaction_date', `${sellDatePrefix}T23:59:59`);

        if (linkedFees && linkedFees.length > 0) {
          // Restore commission amounts to cash
          const totalFeeRestoration = linkedFees.reduce(
            (sum, fee) => sum + Math.abs(parseFloat(fee.total_amount || 0)), 0
          );
          if (totalFeeRestoration > 0) {
            const cashPosId = await ensureCashPosition(brokerId, assetCurrency);
            if (cashPosId) {
              await adjustPositionQty(cashPosId, totalFeeRestoration);
            }
          }
          // Delete the linked FEE transactions
          const feeIds = linkedFees.map(f => f.id);
          await supabase.from('transactions').delete().in('id', feeIds);
        }
      }

      const response = await supabase.from('transactions').delete().eq('id', tx.id).select();
      if (response.error) throw response.error;

      if (!response.data || response.data.length === 0) {
        throw new Error('Supabase no eliminó ninguna fila. Probablemente por RLS (Row Level Security).');
      }

      toast({ title: t('cartera.transaction_deleted') });
      await loadPositions(selectedBrokerId);
      await refreshLoadedTransactions();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: t('common.error_delete'),
        description: err.message + (err.details ? ': ' + err.details : '')
      });
    } finally {
      setTransactionToDelete(null);
      setManualEntryLoading(false);
    }
  };

  const confirmDeletePosition = async () => {
    if (!positionToDelete) return;
    const pos = positionToDelete;
    setPositionToDelete(null);
    setManualEntryLoading(true);
    try {
      // Delete the position's transaction history first (same order the broker
      // replace-mode wipe uses — transactions reference position_id).
      const { error: delTransErr } = await supabase.from('transactions')
        .delete().eq('position_id', pos.id);
      if (delTransErr) throw delTransErr;
      const { data: deleted, error: delPosErr } = await supabase.from('positions')
        .delete().eq('id', pos.id).select();
      if (delPosErr) throw delPosErr;
      if (!deleted || deleted.length === 0) {
        throw new Error('Supabase no eliminó ninguna fila. Probablemente por RLS (Row Level Security).');
      }
      toast({ title: t('cartera.position_deleted') });
      await loadPositions(selectedBrokerId);
    } catch (err) {
      toast({ variant: 'destructive', title: t('common.error_delete'), description: err.message });
    } finally {
      setManualEntryLoading(false);
    }
  };

  return {
    // modal open state
    isAddSaleOpen, setIsAddSaleOpen,
    isAddDividendOpen, setIsAddDividendOpen,
    isAddCommissionOpen, setIsAddCommissionOpen,
    isAddCashOpen, setIsAddCashOpen,
    manualEntryLoading,
    // form state + defaults
    defaultManualCash,
    manualSale, setManualSale,
    manualDividend, setManualDividend,
    manualCommission, setManualCommission,
    manualCash, setManualCash,
    // delete flows
    isDeleteConfirmOpen, setIsDeleteConfirmOpen,
    transactionToDelete,
    positionToDelete, setPositionToDelete,
    // selectors
    availablePositions,
    cashPositionId,
    // primitives shared with CarteraPage flows
    adjustPositionQty,
    ensureCashPosition,
    // handlers
    handleSaveManualSale,
    handleSaveManualDividend,
    handleSaveManualCommission,
    handleSaveManualCash,
    handleDeleteTransaction,
    confirmDeleteTransaction,
    confirmDeletePosition,
  };
}
