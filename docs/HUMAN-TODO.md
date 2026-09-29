# Human-only steps for DOGFOOD

Each step is prepared so it takes under two minutes. Nothing here needs a
secret pasted into chat: the portal has no secrets at all, and the repository
is already public.

Deadline: **19:00 UTC**. Submit by **18:15** to leave room for the form.

---

## H1 — Repo is pushed (DONE, nothing to do)

`https://github.com/vaibhav4046/dogfood-2026` is public, on branch `master`,
at the commit you are reading this from. Licence Apache-2.0 is committed and
`package.json` says `license: "Apache-2.0"`.

## H2 — Record a voiceover, or ship the captioned clip (optional, 10 min)

A 1m20s captioned clip already exists:

- `docs/demo/demo.mp4` (H.264)
- `docs/demo/demo.webm`
- `docs/demo/demo.srt` (captions, 18 cues)

If you want narration, `docs/demo/demo.srt` is the timed script. Play the
video and read the cues aloud. Re-encode with the repo's own script:

```
npm run encode-demo
```

If you do not record one, submit the captioned version. It is honest either
way. Do not describe it as the 5-minute lifecycle video; it is not.

## H3 — Upload the video (5 min)

The submission form needs a URL. Upload `docs/demo/demo.mp4` to YouTube
unlisted, or wherever the form accepts a file.

Suggested title:

```
DOGFOOD 2026: run a hackathon on your own server, with judging you can verify
```

Suggested description (adjust only if what you uploaded differs):

```
DOGFOOD is a self-hosted hackathon and judging platform. One command starts it,
it works with the network disconnected, and every published score traces back to
the judge who wrote it.

Shown in this clip, recorded from the real running app against the official
fixtures: a participant submits a project, edits it before the deadline, a judge
scores it from the Judge Desk, and a late submission is refused by the backend
rather than by a disabled button.

The acceptance checker output is unchanged: claimed T1 T2, verified T1 T2.

Repo: https://github.com/vaibhav4046/dogfood-2026
```

## H4 — Submit (10 min)

Field-by-field text is in `docs/SUBMISSION.md`. Copy each block into the
matching form field. The two that people get wrong:

- **Tiers claimed:** `T1, T2`. Nothing else. Do not claim T3 or T4.
- **Known limits:** paste the list from `docs/SUBMISSION.md` verbatim,
  including that Docker has not been executed. Removing it is the single
  easiest way to lose the submission on a judge's spot check.

## H5 — Write Up Quest (if you are entering it)

`docs/WRITEUP.md` is the entry, written in first person plural and grounded in
the evidence files. Publish it where the quest requires. If the rules ask for
a link, use the raw file URL from the pushed repository:

```
https://github.com/vaibhav4046/dogfood-2026/blob/master/docs/WRITEUP.md
```

---

## Not needed, deliberately

- **No secrets.** DOGFOOD has no API keys, no database URL, no external
  service. The four test logins are derived from a fixed seed and printed in
  the boot banner.
- **No Docker on this machine.** Docker is proven by the judge, not by us. The
  Dockerfile is reviewed but unrun, and every document says so.
- **No npm publish, no registry, no DNS.**
