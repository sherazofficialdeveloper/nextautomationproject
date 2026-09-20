import React, { useState } from 'react';
import { z } from 'zod';
import { BrandLogoIcon } from '../../components/Icons';
import { login } from '../../services/authService';

const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, 'Please enter your username or email.'),
  password: z
    .string()
    .min(1, 'Please enter your password.'),
});

export function LoginPage({ onLoginSuccess }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    const validation = loginSchema.safeParse({ identifier, password });
    if (!validation.success) {
      setError(validation.error.issues[0].message);
      return;
    }

    try {
      setLoading(true);
      const data = await login(validation.data.identifier, validation.data.password);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err.message || 'Login failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page-container">
      <div className="login-glass-card">
        <div className="login-brand-header">
          <div className="login-logo-wrap">
            <BrandLogoIcon size={44} />
          </div>
          <h1>NETX Pro</h1>
          <p>Management Platform & Licensing Portal</p>

          <div className="role-tag-hint">
            <span className="role-pill-preview">Super Admin</span>
            <span className="role-pill-preview">Admin</span>
            <span className="role-pill-preview">Seller</span>
          </div>
          <p>Sign in to your account</p>
        </div>

        {error && <div className="alert-box error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username / Email</label>
            <input
              type="text"
              className="form-input"
              placeholder="Enter your username"
              placeholder="Enter your username or email"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              disabled={loading}
              autoFocus
              required
            />
          </div>

          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              className="form-input"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={loading}
            style={{ width: '100%', justifyContent: 'center', padding: '13px', marginTop: '12px' }}
          >
            <span>{loading ? 'Authenticating...' : 'Sign In to Panel'}</span>
            <span>{loading ? 'Signing in...' : 'Sign In'}</span>
          </button>
        </form>
      </div>
    </div>
  );
}

