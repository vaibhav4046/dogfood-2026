# How DOGFOOD stops a judge from seeing or distorting anything they should not

A hackathon loses its meaning in two ways: judges disagree wildly about the
same work, and judges read each other's answers. We built DOGFOOD to make both
fail loudly rather than quietly, and this is the story of how, including the
mistake that taught us the first one is easy to get wrong.

## The leak we shipped and did not see

Late in the build, an independent reviewer asked a simple question: can a judge
reach `GET /api/organizer/results`? We checked. We had already closed that
route. Our own code comment said so, and our threat model said so, and both were
wrong. The route existed, and it returned every judge's severity statistics,
including the exact rows behind them. Thirty-one judges were exposed.

What makes this worth writing down is not the bug. It is that every artefact we
had for checking our own work agreed with each other and all three were wrong.
The unit tests passed. The route was documented as removed. The threat model
listed it as mitigated. Three sources of truth that all derive from the same
assumption: that a route is closed because we said we closed it.

So we stopped writing route lists. The test now reads the Express route table at
runtime, calls every reachable route as a judge, and inspects the *structure* of
every response body for another judge's identifying fields. It cannot miss a
route nobody remembered to enumerate, because it never enumerates by hand.

And then we proved the test could fail. `npm run prove:sweep` reopens the leak,
runs the sweep, and reports every judge the sweep now catches. It names all
thirty-one, then restores the file. A security test that has never been seen to
fail is a test that might not work.

## Making the judges agree

The second failure is quieter. Take two judges and the same project: one gives
it a 4, the other a 2. That is not noise, it is the event's result, and it is
decided by whoever happened to be assigned.

We do not average that away. We publish the math instead. Raw scores are
normalized per judge against that judge's own rubric bounds, so a judge who
scores everything low is re-centred rather than treated as harsh, and the
normalization applies explicit shrinkage, so a judge who saw only two projects
cannot swing the result as hard as a judge who saw forty. On the shipped
fixtures the raw spread runs from 2.000 to 4.222; after normalization the same
judges are on a comparable scale, and every number in our documentation comes
from a proof document that is regenerated from the real fixtures rather than
typed by hand.

That proof has a fingerprint, and the fingerprint is order-independent, so
reordering the reviews does not change it. A judge can recompute it in one
command and compare. We consider normalisation that cannot be reproduced to be
a claim rather than a method, and we would rather ship the weaker version we can
prove.

The Calibration Lab exists so a human can check the arithmetic without reading
any code. Raw ranking, normalized ranking, signed rank movement as text, a
per-judge severity strip drawn from the real numbers, and a coverage bar. The
memorable moment is the one that makes the case: identical work, scored far
apart by two judges, closing most of that gap once normalization runs.

## What the acceptance checker is for

We did not write our own test of whether DOGFOOD works. The organisers wrote
`run.py` and the fixtures, and we run theirs, unmodified, against a server we
started with one command. The current output is seven of seven PASS with the
line `claimed T1 T2, verified T1 T2`. We claim T1 and T2 because the checker
says T1 and T2. We do not claim T3, and we do not claim Docker.

That last one is a real gap. This machine has no Docker daemon and no package
manager to install one, so our `Dockerfile` and `docker-compose.yml` are
reviewed but have never been executed. Every document we publish says exactly
that, in the first screen of the README, because the alternative is a claim
that costs the whole submission when a judge runs it and it fails.

## What is left

The honest list: no Docker proof yet, no T3 community layer, no pairwise
Bradley-Terry mode, no collusion detector, and CSRF protection limited to an
Origin and Referer check with no synchronizer token. We would rather publish
that list than a feature list, because a judge who finds an unlisted gap stops
trusting everything else in the document too.

The thread through all of it: a judging platform's only real product is trust.
Every claim we make is backed by a command someone can run and a file we
committed, and where we could not produce that file, we say so in the same
sentence as the claim.

## Links

- Repository: https://github.com/vaibhav4046/dogfood-2026
- `README.md` for the one-command start and the acceptance line
- `JUDGING.md` for the rubric and the normalization maths
- `normalization-proof.md` for the regenerated proof and its fingerprint
- `THREAT-MODEL.md`, which now records the header-identity backdoor and how
  `DOGFOOD_MODE` gates it
- `docs/OPERATIONS.md` for the runbook
