// Creates (or updates the password of) a login for an owner listed in public.owners.
// Usage: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/create-login.mjs <email> <password>
// The secret key is the project's service key: never put it in the web app or commit it.
const [email, password] = process.argv.slice(2);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!email || !password || !url || !key) {
  console.error('Usage: SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/create-login.mjs <email> <password>');
  process.exit(1);
}
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const res = await fetch(`${url}/auth/v1/admin/users`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ email, password, email_confirm: true }),
});
if (res.ok) {
  console.log(`Логин создан: ${email}`);
} else {
  const body = await res.json().catch(() => ({}));
  if (res.status === 422 || /already/i.test(JSON.stringify(body))) {
    const list = await (await fetch(`${url}/auth/v1/admin/users?per_page=1000`, { headers })).json();
    const user = list.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!user) throw new Error('Пользователь не найден');
    const upd = await fetch(`${url}/auth/v1/admin/users/${user.id}`, { method: 'PUT', headers, body: JSON.stringify({ password }) });
    if (!upd.ok) throw new Error(`Не удалось обновить пароль: ${upd.status}`);
    console.log(`Пароль обновлён: ${email}`);
  } else {
    throw new Error(`Ошибка ${res.status}: ${JSON.stringify(body)}`);
  }
}
