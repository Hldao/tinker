// 邮件发送 · Resend wrapper
// 没设 RESEND_API_KEY 时 fallback 到 console (开发时方便看链接 · 不挡流程)

const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Tinker <onboarding@resend.dev>';
// resend.dev sandbox 域名 · 只能发到 RESEND 账号验证过的邮箱
// 生产前去 Resend dashboard 验证一个域名 · 改 EMAIL_FROM 环境变量

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function buildLoginEmail(magicLink) {
  const subject = '进 Tinker · 5 分钟内点链接';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif;color:#1c1917;background:#faf9f6;padding:40px 24px;">
<div style="max-width:520px;margin:0 auto;">
  <h1 style="font-size:24px;font-weight:500;margin:0 0 24px 0;">进 Tinker</h1>
  <p style="font-size:15px;line-height:1.65;color:#44403c;margin:0 0 28px 0;">
    点这个按钮登录 · <strong>5 分钟内有效</strong>。
  </p>
  <p style="margin:0 0 28px 0;">
    <a href="${magicLink}" style="display:inline-block;background:#c2410c;color:#fff;text-decoration:none;padding:14px 28px;border-radius:4px;font-size:15px;font-weight:500;">进 Tinker →</a>
  </p>
  <p style="font-size:13px;color:#78716c;margin:0 0 12px 0;">
    或者复制下面这个链接到浏览器:
  </p>
  <p style="font-size:12px;font-family:'JetBrains Mono',monospace;color:#78716c;word-break:break-all;margin:0 0 32px 0;">
    ${magicLink}
  </p>
  <hr style="border:none;border-top:1px solid #e7e5e4;margin:32px 0;">
  <p style="font-size:12px;color:#a8a29e;line-height:1.6;margin:0;">
    不是你点的? 忽略这封邮件即可 · 没人能用过期链接登录。<br>
    Tinker · 给"用 AI 创造但不必懂代码"的人的工作室。
  </p>
</div>
</body></html>`;
  const text = `进 Tinker · 5 分钟内点链接

${magicLink}

不是你点的? 忽略即可 · 没人能用过期链接登录。`;
  return { subject, html, text };
}

async function sendLoginEmail(toEmail, magicLink) {
  const { subject, html, text } = buildLoginEmail(magicLink);
  if (!resend) {
    // dev fallback · 没 API key 时打印到 console
    console.log('━━━ EMAIL (dev mode · no RESEND_API_KEY) ━━━');
    console.log(`  TO: ${toEmail}`);
    console.log(`  SUBJECT: ${subject}`);
    console.log(`  LINK: ${magicLink}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return { id: 'dev-mode-' + Date.now() };
  }
  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: toEmail,
    subject,
    html,
    text,
  });
  if (result.error) throw new Error('Resend 发送失败: ' + result.error.message);
  return result.data;
}

module.exports = { sendLoginEmail };
