"""Step 5 -- alerting.

After each run a summary is sent to the configured recipients by WhatsApp and
email: GREEN (all passed), AMBER (non-material exceptions auto-handled), RED
(material exceptions needing approval). Channels are optional: if credentials or
recipients are missing the agent logs the summary and records it to the audit
table instead of failing the run. In dry-run mode nothing is sent.
"""
import smtplib
from email.mime.text import MIMEText

import requests

from . import config


def overall_color(reds: int, ambers: int) -> str:
    if reds > 0:
        return "RED"
    if ambers > 0:
        return "AMBER"
    return "GREEN"


def _approval_links(exc_id) -> str:
    if not config.APPROVAL_BASE_URL:
        return (f"approve: run `python3 -m validation_agent.run --approve {exc_id}`  |  "
                f"reject: `python3 -m validation_agent.run --reject {exc_id}`")
    base = config.APPROVAL_BASE_URL.rstrip("/")
    return f"approve: {base}/approve/{exc_id}   reject: {base}/reject/{exc_id}"


def render_text(summary: dict) -> str:
    color = summary["color"]
    lines = [
        f"[{color}] Vivo BI data-validation run {summary['run_id']}",
        f"Window {summary['window']}  |  env={summary['env']}",
        f"Checks: {summary['checks']}  Passed: {summary['passed']}  "
        f"Tier-1: {summary['tier1']}  Tier-2: {summary['tier2']}",
        f"Auto-handled (AMBER): {summary['ambers']}   "
        f"Needs approval (RED): {summary['reds']}",
    ]
    if summary.get("definitions"):
        lines.append("")
        lines.append("Definitions used / residuals:")
        for d in summary["definitions"]:
            lines.append(f"  - {d}")
    if summary.get("red_items"):
        lines.append("")
        lines.append("RED items needing approval:")
        for it in summary["red_items"]:
            lines.append(
                f"  * {it['entity']} / {it['metric'] or it['check_code']} "
                f"@ {it['period_date']}: observed {it['observed']}, "
                f"expected [{it['expected_low']}, {it['expected_high']}]")
            if it.get("diagnosis"):
                lines.append(f"    diagnosis: {it['diagnosis']}")
            if it.get("proposed_fix_sql"):
                lines.append(f"    proposed fix: {it['proposed_fix_sql']}")
            lines.append(f"    {_approval_links(it['id'])}")
    return "\n".join(lines)


def _send_email(subject: str, text: str) -> dict:
    if not config.ALERT_EMAILS:
        return {"sent": False, "reason": "no recipients"}
    if config.SENDGRID_API_KEY:
        try:
            r = requests.post(
                "https://api.sendgrid.com/v3/mail/send",
                headers={"Authorization": f"Bearer {config.SENDGRID_API_KEY}",
                         "Content-Type": "application/json"},
                json={
                    "personalizations": [{"to": [{"email": e} for e in config.ALERT_EMAILS]}],
                    "from": {"email": config.SMTP_FROM or "alerts@vivofashiongroup.com"},
                    "subject": subject,
                    "content": [{"type": "text/plain", "value": text}],
                }, timeout=30)
            return {"sent": r.status_code < 300, "status": r.status_code}
        except Exception as e:  # noqa: BLE001
            return {"sent": False, "reason": str(e)}
    if config.SMTP_HOST and config.SMTP_FROM:
        try:
            msg = MIMEText(text)
            msg["Subject"] = subject
            msg["From"] = config.SMTP_FROM
            msg["To"] = ", ".join(config.ALERT_EMAILS)
            with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=30) as s:
                s.starttls()
                if config.SMTP_USER:
                    s.login(config.SMTP_USER, config.SMTP_PASS)
                s.sendmail(config.SMTP_FROM, config.ALERT_EMAILS, msg.as_string())
            return {"sent": True}
        except Exception as e:  # noqa: BLE001
            return {"sent": False, "reason": str(e)}
    return {"sent": False, "reason": "no email provider configured"}


def _send_whatsapp(text: str) -> dict:
    if not config.ALERT_WHATSAPP:
        return {"sent": False, "reason": "no recipients"}
    if not (config.TWILIO_SID and config.TWILIO_TOKEN and config.TWILIO_WHATSAPP_FROM):
        return {"sent": False, "reason": "twilio not configured"}
    results = []
    for to in config.ALERT_WHATSAPP:
        try:
            r = requests.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{config.TWILIO_SID}/Messages.json",
                data={"From": config.TWILIO_WHATSAPP_FROM,
                      "To": to if to.startswith("whatsapp:") else f"whatsapp:{to}",
                      "Body": text[:1500]},
                auth=(config.TWILIO_SID, config.TWILIO_TOKEN), timeout=30)
            results.append(r.status_code < 300)
        except Exception:
            results.append(False)
    return {"sent": all(results) and bool(results), "count": len(results)}


def send(summary: dict, dry_run: bool) -> dict:
    text = render_text(summary)
    if dry_run:
        return {"dry_run": True, "email": {"sent": False, "reason": "dry-run"},
                "whatsapp": {"sent": False, "reason": "dry-run"}, "text": text}
    subject = f"[{summary['color']}] Vivo BI data validation — {summary['window']}"
    return {"email": _send_email(subject, text),
            "whatsapp": _send_whatsapp(text), "text": text}
