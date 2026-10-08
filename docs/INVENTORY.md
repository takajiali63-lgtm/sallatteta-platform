# Aklatak — لائحة الحسابات والخدمات + ورقة الطوارئ

> **لا يحتوي هذا الملف على أي كلمة سر أو مفتاح، عمداً.** فيه: ما هي كل خدمة، معرّفها، وأين يُحفظ سرّها، وماذا تفعل إن ضاع شيء.
> آخر تحديث: 2 تشرين الأول 2026 — النسخة 4.5.2.

## 1. أين تحفظ الأسرار (مرة واحدة، ولا تضيع بعدها)
| السرّ | أين تحفظه |
|---|---|
| كلمات سر الحسابات (Gmail، GitHub، Render، Neon، Cloudflare، Geoapify، UptimeRobot، لوحة الإدارة) | **Google Password Manager** على الهاتف (محمي بالبصمة) |
| رموز الاسترجاع لـ GitHub + الرموز الاحتياطية للوحة الإدارة | **Google Drive** خاص (مجلد «Aklatak – طوارئ») + نسخة ورقية في البيت |
| **مجلد التطبيق من PWABuilder** (`signing.keystore` + `signing-key-info.txt` + `Aklatak.apk` + `Aklatak.aab`) | **Google Drive** خاص — **بدونه لا يمكن تحديث التطبيق نفسه أبداً** |
| آخر **نسخة احتياطية كاملة** (لوحة الإدارة ← النسخ الاحتياطي) | **Google Drive** خاص — مرة في الشهر على الأقل، وقبل أي تعديل كبير |
| آخر ملف `sallatteta-platform.zip` | **Google Drive** باسم النسخة (مثلاً `aklatak-4.5.2.zip`) |

## 2. الخدمات
| الخدمة | ما هي | المعرّف (ليس سراً) | أين السرّ |
|---|---|---|---|
| **Gmail** `takajiali63@gmail.com` | **مفتاح كل الحسابات** (استرجاع كلمات السر يصل إليه) | — | Google (فعّل التحقّق بخطوتين / Passkey) |
| **GitHub** | الكود (`sallatteta-platform.zip`) | حساب `takajiali63-lgtm` · مستودع **خاص** `sallatteta-platform` | حسابك + 2FA (Google Authenticator) + رموز الاسترجاع |
| **GitHub (التطبيق)** | ملف التنزيل للزوار | مستودع **عام** `aklatak-app` (Releases ← `Aklatak.apk` فقط) | نفس الحساب |
| **Render** | يشغّل الموقع | خدمة `srv-dau2rp2d0e5s73e1i2og` · workspace `tea-daphsa6k1f9s7393ulrg` · Ohio · Free | حسابك (دخول بـ GitHub/Google) |
| **Neon** | قاعدة البيانات (كل البيانات) | Postgres · us-east-2 · قاعدة `neondb` | `DATABASE_URL` في Render |
| **Geoapify** | البلدات والعناوين والبحث عن العنوان | مشروع `Aklatak` (خطة مجانية: 3000 رصيد/يوم، شرط «Powered by Geoapify») | `GEOAPIFY_API_KEY` في Render |
| **UptimeRobot** | تنبيه فوري إذا وقع الموقع | يراقب `/readyz` كل 5 دقائق | حسابك (Gmail) |
| **تطبيق Android** | Aklatak على Android (TWA) | الحزمة `com.aklatak.app` · الإصدار 1.0.0.0 (code 1) | المفتاح في مجلد PWABuilder (Drive) |
| **ربط التطبيق بالموقع** | يفتح الروابط في التطبيق بلا شريط عنوان | `ANDROID_PACKAGE_NAME` + `ANDROID_SHA256_CERT_FINGERPRINTS` في Render (البصمة ليست سراً، موجودة في `assetlinks.json`) | — |
| **الدومين** | العنوان الرسمي | `aklatak.net` (للشراء من Cloudflare) · `aklatak.com` محجوز | حساب Cloudflare |
| **لوحة الإدارة** | `/admin/` + من صفحة «تسجيل الدخول» (زر Aa) | المستخدم `ali.takaji` | كلمة السر + Passkey + 10 رموز احتياطية |
| **WhatsApp الإدارة** | يستقبل طلبات الاشتراك | `96176691688` (إعدادات الموقع) | قفل WhatsApp بالبصمة (كلمات سر المشتركين تصل إليه) |
| **OpenStreetMap / Nominatim** | بديل مجاني للبلدات | — | لا يحتاج مفتاحاً |
| **Shopify (سلة تيتا)** | متجر منفصل | — | **لا ارتباط تقني** بالمنصة |

## 3. متغيّرات البيئة في Render (الأسماء فقط)
`DATABASE_URL` · `DATABASE_SSL` · `SESSION_SECRET` · `ADMIN_WHATSAPP_NUMBER` · `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` (أول تشغيل فقط) · طوارئ: `ADMIN_RESET_USERNAME` / `ADMIN_RESET_PASSWORD` (احذفهما بعد الاستعمال) · `GEOAPIFY_API_KEY` · `ANDROID_PACKAGE_NAME` · `ANDROID_SHA256_CERT_FINGERPRINTS` · اختيارية: `DEEPL_API_KEY` (ترجمة تلقائية) · `REDIS_URL` (ذاكرة مشتركة عند عدّة سيرفرات) · `POSTGIS=off` (لتعطيل البحث المكاني) · `S3_*` (R2 — مفعّلة) · `PUBLIC_BASE_URL` (بعد الدومين) · `IOS_APP_ID` · `S3_*` (صور R2) · `REDIS_URL` · `METRICS_TOKEN`.
> انسخ قيمها مرة واحدة إلى Google Password Manager (ملاحظة آمنة باسم «Aklatak – Render»).

## 4. ورقة الطوارئ — ماذا تفعل إذا…
| ماذا حدث | الحل |
|---|---|
| **الموقع لا يفتح** (رسالة UptimeRobot) | انتظر دقيقة (الخطة المجانية تنام). إن استمر: Render ← الخدمة ← Logs، أرسل صورة. حل دائم: Render Starter (~7$) |
| **رفعت نسخة فيها مشكلة** | Render ← Deploys ← اختر النسخة السابقة ← **Rollback**. أو ارفع آخر zip سليم من Drive |
| **ضاع الهاتف** | Gmail: افتح من جهاز آخر واسترجع. GitHub: رمز استرجاع. لوحة الإدارة: كلمة السر + رمز احتياطي، ثم احذف Passkey الهاتف الضائع وأضف واحدة جديدة |
| **نسيت كلمة سر الإدارة** (أو ضاع هاتف الـ Passkey) | Render ← Environment ← أضف `ADMIN_RESET_USERNAME` = `ali.takaji` و`ADMIN_RESET_PASSWORD` = كلمة سر جديدة (10 أحرف على الأقل) ← Save ← انتظر التشغيل ← ادخل بها ← **احذف المتغيّرين فوراً** ← فعّل Passkey جديدة. يُطفئ شرط الـ Passkey ويُخرج كل الجلسات |
| **Render أو Neon اختفى أو أغلق الحساب** | موقع جديد في أي استضافة (Render جديد، أو Docker) بالكود من آخر zip ← قاعدة Postgres فارغة ← لوحة الإدارة الجديدة ← «استرجاع من نسخة» ← ارفع آخر نسخة احتياطية. التفاصيل: `MIGRATION.md` |
| **تسرّبت كلمة سر قاعدة البيانات** | Neon ← Roles ← Reset password ← انسخ الرابط الجديد ← Render ← `DATABASE_URL` ← Save |
| **تسرّب مفتاح Geoapify** | Geoapify ← المشروع ← مفتاح جديد ← احذف القديم ← Render ← `GEOAPIFY_API_KEY` |
| **ضاع مفتاح التطبيق (keystore)** | لا يمكن تحديث التطبيق نفسه: تطبيق جديد باسم حزمة جديد، والمستخدمون ينزّلونه من جديد. **لهذا احفظه في Drive** |
| **تريد تحديث التطبيق** (اسم/أيقونة) | PWABuilder ← نفس الإعدادات ← Version code +1 ← Signing key: **Use mine** (المفتاح وكلمة سرّه من Drive) |
| **حدّثت الموقع** | لا شيء للتطبيق: يتحدّث وحده |
| **انتقلت للدومين** | Render ← Custom Domains ← سجلّات Cloudflare ← `PUBLIC_BASE_URL` ← إعادة بناء التطبيق بالدومين الجديد بنفس المفتاح ← Passkey جديدة للإدارة |

## 5. الروتين الشهري (10 دقائق)
1. لوحة الإدارة ← **تنزيل نسخة كاملة** ← Google Drive.
2. «أمان حسابي» ← راجع **سجلّ الدخول** (أي دخول غريب؟).
3. UptimeRobot: هل كان هناك توقّف؟
4. Geoapify: الاستهلاك أقل من الحد المجاني؟
5. Neon: المساحة (الخطة المجانية 0.5 GB) — عند الاقتراب: Neon مدفوع أو صور R2.
