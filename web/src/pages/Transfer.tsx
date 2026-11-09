import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../lib/api';
import { localInputToISO, nowLocalInput, tg } from '../lib/format';
import { useAccounts } from '../lib/data';
import { AccountPicker, Card, Field, Loading, MoneyInput, Page, SubmitBar, amountOf, useSubmit } from '../components/ui';

export default function Transfer() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const accounts = useAccounts();
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [at, setAt] = useState(nowLocalInput());
  const [note, setNote] = useState('');

  const s = useSubmit(
    (requestId) => rpc('record_transfer', {
      p_request_id: requestId, p_from: from, p_to: to, p_amount: amountOf(amount),
      p_at: localInputToISO(at), p_note: note.trim() || null,
    }),
    () => { qc.invalidateQueries(); nav(-1); },
  );

  if (accounts.isLoading) return <Loading />;
  const fromAcc = accounts.data?.find((a) => a.account_id === from);

  return (
    <Page title="Перевести деньги" back>
      <Card>
        <Field label="Откуда" error={s.errorFor('from')}>
          <AccountPicker accounts={accounts.data} value={from} onChange={setFrom} showBalance />
        </Field>
        <Field label="Куда" error={s.errorFor('to')}>
          <AccountPicker accounts={accounts.data} value={to} onChange={setTo} showBalance />
        </Field>
        <Field label="Сумма" error={s.errorFor('amount')}
          hint={fromAcc ? `На счёте «${fromAcc.name}» сейчас ${tg(fromAcc.balance)}` : undefined}>
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
        </Field>
        <Field label="Когда">
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
        <Field label="Заметка (необязательно)">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например, снял в банкомате" />
        </Field>
        <div className="explain">Общая сумма денег не меняется — деньги просто перекладываются с одного счёта на другой.</div>
      </Card>
      <SubmitBar label={`Перевести ${amountOf(amount) > 0 ? tg(amountOf(amount)) : ''}`.trim()} busy={s.busy} onClick={s.submit} error={s.generalError} />
    </Page>
  );
}
