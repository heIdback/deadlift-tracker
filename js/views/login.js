import { signInWithGoogle } from '../core/auth.js';
import { APP_META } from '../../config/app.config.js';

export async function mount(root) {
  root.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <h1 class="login-title">${APP_META.name}</h1>
        <p class="login-byline">by ${APP_META.publisher}</p>
        <p class="login-subtitle">Your training dashboard and workout logger.</p>
        <button class="btn btn-primary btn-large" id="google-signin-btn">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.85A11 11 0 0 0 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.09V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.94z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85C6.71 7.31 9.14 5.38 12 5.38z"/>
          </svg>
          <span>Continue with Google</span>
        </button>
        <p class="login-error" id="login-error" role="alert" hidden></p>
      </div>
    </div>
  `;

  const btn = root.querySelector('#google-signin-btn');
  const errorEl = root.querySelector('#login-error');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    errorEl.hidden = true;
    try {
      await signInWithGoogle();
      location.hash = '#/home';
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}
