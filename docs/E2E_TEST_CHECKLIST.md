# End-to-End Test Checklist

Manual smoke tests for core features. Run after any change to chat,
uploads, conversations, auth, or storage. Each box should be checkable
in one sitting (~10 min total).

**Setup once per run**
- [ ] Logged in as a real test user (e.g. `test@gmail.com`)
- [ ] DevTools open → **Console** + **Network** tabs visible
- [ ] No red errors in Console at page load
- [ ] Sidebar lists existing conversations within ~1s

---

## 1. Chat — text prompt → streamed reply

- [ ] Click **New chat** (or open an existing empty conversation)
- [ ] Type `Say hello in exactly three words.` and press **Enter**
- [ ] User message appears immediately in the thread
- [ ] Assistant bubble appears within ~2s and **streams** token-by-token
       (not a single dump at the end)
- [ ] Reply is coherent and ~3 words
- [ ] Network tab: `POST /api/chat/stream` → status **200**, `content-type: text/event-stream`
- [ ] Stop button appears while streaming, disappears when done
- [ ] After completion, refresh the page → both messages persist

**Edge cases**
- [ ] Send an empty message → Send button stays disabled (no request fires)
- [ ] Send a 5,000-char message → still streams, no truncation in UI
- [ ] Click **Stop** mid-stream → streaming halts, partial reply remains saved

---

## 2. File uploads — parsing + storage

Test each file type against the same conversation.

### 2a. Plain text (`.txt` / `.md`)
- [ ] Drop a small `.txt` file (≤100 KB) into the composer
- [ ] Chip shows filename + spinner with stage "uploading"
- [ ] Within ~3s the chip turns into a green check (no error icon)
- [ ] Send the message `Summarize this file.`
- [ ] Reply references actual content of the file (proves extraction reached the model)

### 2b. PDF
- [ ] Attach a 1–5 page PDF
- [ ] Chip stage shows "parsing"
- [ ] Reply quotes or summarizes real PDF text

### 2c. Spreadsheet (`.csv` / `.xlsx`)
- [ ] Attach a small CSV with headers
- [ ] Ask `What columns are in this file?`
- [ ] Reply lists the actual column names

### 2d. Image (OCR)
- [ ] Attach a JPG/PNG containing visible text
- [ ] Chip shows OCR stage (scan icon)
- [ ] Ask `What text is in this image?`
- [ ] Reply contains the text from the image

### 2e. Failure paths
- [ ] Attach a file >25 MB → toast: "That file is too large…", no upload starts
- [ ] Attach an unsupported binary (e.g. `.zip`) → uploads, but reply says it can't read the contents (graceful, not crashed)
- [ ] Network tab: every successful upload returns **200** to `uploadChatFile`,
       and the response JSON includes a non-null `url` (signed URL) **and** non-null `extracted_text`
       for parseable types
- [ ] No `403` / `row-level security` errors in Network or Console

---

## 3. Conversation switching

- [ ] Open conversation A, send a message, wait for reply
- [ ] Click conversation B in sidebar — thread switches in <500 ms
- [ ] Messages from A do **not** bleed into B
- [ ] Send a message in B → streams in B, A is untouched
- [ ] Switch back to A mid-stream of B → B's stream keeps running in background;
       returning to B shows the completed reply
- [ ] Sidebar reorders: most recently active conversation rises to top
- [ ] Click **New chat** → creates conversation, URL/state updates, composer is empty,
       no leftover draft text from the previous chat
- [ ] Refresh the page on conversation A → still on A, full history loaded

**Drafts**
- [ ] Type (don't send) in conversation A, switch to B, switch back to A → draft is preserved
- [ ] Send the message → draft is cleared

---

## 4. Rate limiting

Free plan limit: **20 messages / hour** (per `getRateLimitStatus`).

- [ ] Open any conversation; note the current `used / limit` shown in the rate-limit banner (if visible) or check `getRateLimitStatus` in the Network tab
- [ ] Send messages until `used` reaches `limit`
- [ ] On the message that would exceed the limit:
  - [ ] Composer shows a clear "rate limit reached" message
  - [ ] Send button is disabled OR the request is blocked server-side with a friendly error toast (not a raw 429 stack trace)
  - [ ] No partial assistant bubble is left orphaned in the thread
- [ ] `reset_at` timestamp shown to the user is in the future and human-readable
- [ ] After waiting (or in a new test window past the reset), sending works again and `used` resets to 1

**Quick check without burning quota**
- [ ] In DevTools → Network, find any `getRateLimitStatus` response. Confirm shape: `{ used, limit, reset_at, plan }` with sensible values.

---

## Pass criteria

A run is **green** only if every checkbox above is ticked **and**:
- No uncaught errors in the browser console
- No `4xx` / `5xx` responses in Network for happy-path actions
- No "row violates row-level security policy" anywhere
- Refreshing the page never loses sent messages or successful uploads

If any box fails, capture: the failing step, the Network response, and the
Console error, and file it before claiming the feature works.
