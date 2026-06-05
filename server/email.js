// 邮件发送 · SMTP (兼容阿里云邮件推送 / 腾讯云 / Gmail / 任何 SMTP 提供商)
// 没设 SMTP_HOST 时 fallback 到 console (开发时方便看登录链接 · 不挡流程)

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const EMAIL_FROM = process.env.EMAIL_FROM || (SMTP_USER ? `Tinker <${SMTP_USER}>` : 'Tinker <noreply@example.com>');

// SMTP 准备好时建一个连接池 · 否则 null (走 dev fallback)
const transporter = SMTP_HOST && SMTP_USER && SMTP_PASSWORD
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,  // 465 = SSL · 587/25 = STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      pool: true,            // 连接池 · 避免每封信都重新握手
      maxConnections: 3,
      maxMessages: 100,
    })
  : null;

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
  if (!transporter) {
    // dev fallback · 没配 SMTP 时打印到 console
    console.log('━━━ EMAIL (dev mode · 未配 SMTP) ━━━');
    console.log(`  TO: ${toEmail}`);
    console.log(`  SUBJECT: ${subject}`);
    console.log(`  LINK: ${magicLink}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return { id: 'dev-mode-' + Date.now() };
  }
  const info = await transporter.sendMail({
    from: EMAIL_FROM,
    to: toEmail,
    subject, html, text,
  });
  return { id: info.messageId };
}

module.exports = { sendLoginEmail };
