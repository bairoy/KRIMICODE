# 8 · Quiz and Exercises

Answer from memory first. The answers are folded below each question.

---

## Recall

**1.** At the end of Day 3 every test passed. Name three reasons the product
still wasn't shippable.

<details><summary>answer</summary>

No README (a stranger couldn't start it), no `bin` entry (no `krimicode`
command), no session persistence (close the terminal, lose everything), one
slash command, POSIX-only, no lint, no CI. Any three.

The point: none of those are bugs. Tests cannot see a missing feature.
</details>

**2.** Why was lint added *before* the five feature phases rather than after?

<details><summary>answer</summary>

A formatter added after the features reflows every file you touched, so a
commit saying "added sessions" shows 400 lines of moved brackets and nobody can
review it. Adding it first costs one boring commit and makes every later diff
readable.
</details>

**3.** Biome reported 16 findings. Roughly how many were fixed, and what
happened to the rest?

<details><summary>answer</summary>

Two were real (one implicit `any`, fixed properly). One was a false positive
(exhaustive switch that TypeScript already proves) — suppressed **with a
written reason**. Thirteen were style noise (`process.env['X']`) — the rule was
turned off.

A linter is a colleague with opinions, not a judge.
</details>

**4.** Why does `shellInvocation` take `platform` as a parameter instead of
reading `process.platform`?

<details><summary>answer</summary>

So the Windows branch is reachable from a Mac. `if (process.platform === …)`
can only ever execute one branch on your machine — the other is untestable, and
you could type anything there and never know.
</details>

**5.** `C:\Work\proj` and `c:\work\proj`. Why did this become a security bug?

<details><summary>answer</summary>

They are the *same directory* on Windows, but the workspace boundary used a
case-sensitive `startsWith`. A path genuinely inside the workspace could read as
outside — or, with a root differing only in case, the reverse. That check
protects every file operation in the program.
</details>

**6.** Why `toLowerCase` and not `toLocaleLowerCase`?

<details><summary>answer</summary>

Under a Turkish locale, `toLocaleLowerCase` maps a dotted capital `I` to a
dotless `ı`. Your security boundary would depend on the machine's language
settings.
</details>

**7.** Why is `detached: true` set only on POSIX?

<details><summary>answer</summary>

On Windows it doesn't create a process group at all — it means "give the child
its own console window," which can flash a window on screen and doesn't help
with killing. Windows uses `taskkill /T` instead, which needs no spawn-time
setup.
</details>

**8.** Session persistence shipped as plain functions, not a `SessionStore`
interface. Why?

<details><summary>answer</summary>

CLAUDE.md: no interface until a second real implementation needs one. An
interface written for one implementation is a guess about the second — you'll
guess wrong and be stuck with both the wrong abstraction and the code using it.
Extract it later from two real things.
</details>

**9.** Tool results are already redacted by `normalize.ts`. So why does
`saveSession` redact again?

<details><summary>answer</summary>

Because **your own typing** has never been through the scrubber. Pasting a key
into the prompt to ask about it is a normal thing to do, and without this it
lands on disk in cleartext and outlives the conversation.
</details>

**10.** Why write to `<id>.json.tmp` and rename, instead of writing the real
file?

<details><summary>answer</summary>

`rename` is atomic. Writing in place means a crash leaves a truncated file where
a valid session used to be — you lose the old conversation *and* the new one.
With rename, the file is either entirely old or entirely new.
</details>

**11.** Only two fields need saving to resume a conversation. Which, and why so
few?

<details><summary>answer</summary>

`history` and `summary`. Everything else is configuration or rebuilt per
request — the system message is composed fresh each time from the base prompt
plus the summary (a Day 3 decision made for a different reason entirely).

Clean internal state makes later features almost free.
</details>

**12.** `\x1b[2J` clears the screen. Why is `\x1b[3J` necessary?

<details><summary>answer</summary>

`3J` clears the **scrollback**. Without it you can scroll up and read the entire
conversation the agent has just been told to forget. The screen looks clean;
the transcript is still there.
</details>

**13.** ⭐ Ctrl-C at an idle prompt hung the program. What was the root cause?

<details><summary>answer</summary>

`rl.close()` does not settle a pending `rl.question()` — the promise never
resolves and never rejects. So the `await` never returned, the loop never broke,
and the `finally` that restores the terminal never ran. Raw mode and bracketed
paste were left enabled in a terminal the program no longer controlled.

The fix: abort the question (`{ signal }`) instead of closing the interface.
</details>

**14.** The same root cause broke a second thing. What, and what does that tell
you about the comment on the `catch`?

<details><summary>answer</summary>

Ctrl-D. Its comment said *"stdin closed: Ctrl-D, or piped input exhausted"* —
describing a path that could never execute, because closing the interface was
exactly what failed to settle the promise.

A comment is a claim, and it can be false.
</details>

**15.** ⭐ Explain the redaction / `edit_file` deadlock in three steps.

<details><summary>answer</summary>

1. `read_file` redacts the secret, so the model sees `SECRET_TOKEN=[REDACTED]`.
2. The model copies that into `old_str` — in good faith, it's all it has seen.
3. No match is possible, ever. And the error said *"copy the text verbatim,"*
   which it had done. It retried 22 times.

Both features were correct. The bug was in the seam.
</details>

**16.** Why is `retryable: false` the load-bearing line in that fix?

<details><summary>answer</summary>

The generic "not found" error is `retryable: true`, which is an invitation to
try again. For a placeholder no retry can ever succeed, so telling the model it
may retry is what produced the loop.
</details>

**17.** The loop breaker keys on tool name **and** arguments. Why not name
alone?

<details><summary>answer</summary>

It would stop the model correcting a typo in a path — the second call is a
different call. Only identical failing calls are certain to fail again.
</details>

**18.** The first version of the loop breaker had a hole. Where?

<details><summary>answer</summary>

It was placed *after* the unknown-tool lookup, which `return`s early. A model
inventing the same nonexistent tool repeatedly sailed straight past the guard.
Fixed by splitting `#runTool` (guards) from `#dispatch` (executes).

An early `return` is a hole in everything you add below it.
</details>

**19.** The permission prompt showed `- i love you / + I love you` for a file
containing neither. Nothing dangerous happened. Why is it still serious?

<details><summary>answer</summary>

A prompt that is routinely wrong teaches you to press `y` without reading. Four
prompts in that transcript, zero achievable effects. That habit is how gates get
defeated — not bypassed, rubber-stamped — and the next prompt might be
`rm -rf`.
</details>

**20.** What did adding `precheck` cost?

<details><summary>answer</summary>

Code now runs **before** the permission gate. CLAUDE.md says putting the gate in
one place is what makes "no tool bypasses confirmation" structural instead of a
convention — and `precheck`'s "must not mutate" rule is exactly a convention. A
future tool could write a file there and never reach the gate.

Consent got more accurate; the chokepoint got weaker. A real trade, worth
writing down rather than pretending it was free.
</details>

**21.** In `create_file`, which line is the guarantee that nothing is
overwritten — the precheck, or something else?

<details><summary>answer</summary>

`writeFile(..., { flag: 'wx' })`. It fails atomically if the path exists. The
precheck is a courtesy so you aren't prompted for a doomed creation; delete it
and the property still holds.
</details>

**22.** Three CI jobs failed and one passed. Which passed, and what did that
immediately tell you?

<details><summary>answer</summary>

macOS — the platform everything had been written on. Immediately: the code
isn't wrong in general, it depends on something about macOS. And since *both*
Ubuntu jobs failed at different Node versions, it was Linux itself, not a
version.
</details>

**23.** ⭐ Three Linux tests reported "orphaned processes survived." Was the
process-group kill broken?

<details><summary>answer</summary>

No. Both processes were killed. One was a **zombie** — already dead, waiting to
be reaped — and `pgrep` counts zombies.

The test asserted "nothing matches" when it meant "nothing is still running."
macOS reaped fast enough to hide the race; Linux didn't. The fix was in the
test: filter out `Z` states.
</details>

**24.** Biome wanted to rewrite every line of every file on Windows. What is
that always?

<details><summary>answer</summary>

Line endings. Git checked out CRLF on Windows; Biome formats with LF. Fixed
with `.gitattributes`: `* text=auto eol=lf`.

When a diff is 100% of the file, stop reading the content — the problem is the
invisible characters.
</details>

**25.** Why did running out of API credits turn out to be useful?

<details><summary>answer</summary>

It forced the one architectural claim that had never been tested — swapping to
a different OpenAI-compatible backend — and it worked with only a `.env`
change. It was a *real* test too: the hosted API fragments tool-call arguments
across chunks while Ollama sends them complete, so `ToolCallAccumulator` finally
met the second shape it was written for.
</details>

---

## Build exercises

**A · Close the `precheck` hole.**
Write a test that, for every tool in the registry, runs `precheck` against a
scratch workspace and asserts the directory is byte-identical afterwards. This
turns "must not mutate" from a comment into something CI enforces. *(This is
genuinely still open in the project.)*

**B · Audit the other tools.**
`edit_file` used to prompt before checking the workspace boundary. Do
`read_file`, `list_files`, `search_code` and `git_diff` do the same? Write, for
each, a test using `spyGate` that asserts the gate is **never consulted** for
`../../etc/passwd`. Count how many fail. The README claims all of them refuse
outright.

**C · Pluralise the turn-limit message.** *(Since fixed — the lesson is in how.)*
`MaxTurnsError` said *"Stopped after 1 turns"*, and `--list` said *"1 turns"*.
The interesting part was not the fix but the survey: the codebase had **three**
hand-written `n === 1 ? '' : 's'` ternaries and **six** places with none. Nobody
had decided not to pluralise — each site had been written in isolation, and
half the authors thought of it.

That is the shape of most cosmetic bugs. Go looking for another one in this
repo: pick any formatting decision made inline at a call site, grep for every
place that had to make the same decision, and count how many disagree.

<details><summary>the other thing it taught</summary>

`--list` aligns its columns with `padStart(3)` on the number. Fixing the word
broke the alignment, because "turn" is a character shorter than "turns" — so
the title column jumped left for every single-turn session. The count and its
word have to be padded as one unit.

A fix that is correct in isolation can still be wrong in place. Look at the
output, not just the string.
</details>

**D · `/compact`.** *(Since built — read it instead.)*
Compaction only ran when the budget demanded it, and `/compact` answered
"unknown command". It now exists. Read `commands.ts` and `agent.ts` and answer
three things: how does the dispatcher trigger a compaction while still knowing
nothing about the Agent? Why does `compact()` return `null` instead of a
`CompactionInfo` with zeroes in it? And why does the command print nothing at
all when it succeeds?

<details><summary>answers</summary>

A `compact: () => Promise<CompactOutcome>` callback on `CommandContext`, like
every other capability it has — three outcomes again, because *cancelled* and
*nothing to fold* both mean "no compaction happened" and must not be reported
as the same thing.

`null` because a note reading `0 messages summarized, ~1200 → ~1200 tokens` is
how a working command starts to look broken. Say "nothing to compact" instead.

Nothing is printed on success because the CLI's `onCompact` renderer already
prints the `⟳` line, exactly as it does for an automatic compaction. One event,
one line, one place that draws it.
</details>

**E · Test the `grep` fallback on purpose.**
`search_code` uses ripgrep when present and `grep` otherwise — so on any machine
with `rg`, the fallback is never tested. Force it and assert both paths produce
matching results.

**F · Make a second provider a test.**
Point `OPENAI_BASE_URL` at Ollama and run a scripted conversation end to end.
Then write down every difference you had to accommodate. That list is your real
compatibility surface.

**G · The overwrite question.**
The project deliberately has no tool that can overwrite a file. Write the
argument *for* adding one, and the argument against. Which risk is larger for a
client's codebase: a model that clobbers a file, or a model that cannot do an
ordinary task without a two-step dance?

---

## One last question

**Everything in Day 4 was found by a person typing at a prompt. Nothing was
found by 308 passing tests. So — what are the tests for?**

<details><summary>answer</summary>

They're for **change**. Tests don't find new bugs; they stop you reintroducing
old ones. Every mutation test in Day 4 proved that: revert the fix, watch the
red, restore.

The suite is not a discovery tool. It is a ratchet. Using the software is how
you go forward; the tests are what stop you sliding back.
</details>
