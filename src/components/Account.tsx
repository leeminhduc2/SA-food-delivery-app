import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { api, label } from '../api';
import type { Actor } from '../types';
import { errorText } from '../types';
import { Field } from './Primitives';
export function Auth({ demo, onSuccess }: { demo: boolean; onSuccess: (u: Actor) => void }) {
  const [register, setRegister] = useState(false),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [name, setName] = useState(''),
    [role, setRole] = useState('CUSTOMER'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      const u = await api('/auth/' + (register ? 'register' : 'login'), 'POST', {
        email,
        password,
        name,
        role,
      });
      if (u.pendingApproval) {
        setMessage('Your driver account is waiting for administrator approval.');
        setRegister(false);
      } else onSuccess(u);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="muted">
        {register
          ? 'Create an account and make yourself at home.'
          : 'Sign in for good food and a little everyday joy.'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="info" role="status">
            {message}
          </p>
        )}
        {register && (
          <Field
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            autoComplete="name"
          />
        )}
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <Field
          label="Password"
          type="password"
          minLength={register ? 10 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete={register ? 'new-password' : 'current-password'}
        />
        {register && (
          <label className="field">
            I’m joining as
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="CUSTOMER">Customer</option>
              <option value="RESTAURANT">Restaurant owner</option>
              <option value="DRIVER">Driver (requires approval)</option>
            </select>
          </label>
        )}
        <button className="button full" disabled={busy}>
          {busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}
          <ArrowRight size={17} />
        </button>
      </form>
      <button
        className="text-button full"
        onClick={() => {
          setRegister(!register);
          setError('');
        }}
      >
        {register ? 'Already a neighbor? Sign in' : 'New around here? Create an account'}
      </button>
      {demo && !register && (
        <div className="demo-accounts">
          <strong>Explore the demo</strong>
          <p>
            Select a role to fill the email. Use the password configured in{' '}
            <code>DEMO_PASSWORD</code>.
          </p>
          <div>
            {['customer', 'restaurant', 'driver', 'admin'].map((r) => (
              <button key={r} className="category" onClick={() => setEmail(r + '@bep.local')}>
                {label(r)}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
export function Profile({ actor, setActor }: { actor: Actor; setActor: (u: Actor) => void }) {
  const [name, setName] = useState(actor.name),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          setActor(await api('/auth/me', 'PATCH', { name }));
          setError('Profile saved.');
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field
        label="Your name"
        required
        minLength={2}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {error && <p role="status">{error}</p>}
      <button className="button full" disabled={busy}>
        Save profile
      </button>
    </form>
  );
}
