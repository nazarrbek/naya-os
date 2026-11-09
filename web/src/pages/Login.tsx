import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Field } from '../components/ui';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message.includes('Invalid') ? 'Неверная почта или пароль' : 'Не удалось войти. Проверьте интернет');
  }

  async function reset() {
    if (!email.trim()) {
      setError('Введите почту — пришлём ссылку для нового пароля');
      return;
    }
    await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    setInfo('Ссылка для нового пароля отправлена на почту');
  }

  return (
    <form className="login" onSubmit={signIn}>
      <div className="logo">🎈</div>
      <h1>NAYA BALLOONS</h1>
      <Field label="Почта">
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Пароль" error={error}>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {info ? <div className="notice info">{info}</div> : null}
      <button className="btn primary big" disabled={busy}>{busy ? 'Вхожу…' : 'Войти'}</button>
      <div className="spacer" />
      <button type="button" className="btn ghost" onClick={reset}>Забыли пароль?</button>
    </form>
  );
}
