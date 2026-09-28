"use strict";

/**
 * Judge desk autosave.
 *
 * Behaviour that matters:
 *  - a visible save state, never a silent write ("Saved" / "Saving…"/"Offline,
 *    not saved" / the server's refusal message)
 *  - a draft write is debounced; a submit write is immediate and reports failure
 *  - a refused write (403 not_assigned, 400 out of range) is surfaced verbatim
 *    rather than retried, because retrying a refusal is how a judge loses an
 *    hour believing the software is broken
 *  - reduced motion: no transition on the status text
 */

(function () {
  "use strict";

  var form = document.getElementById("review");
  if (!form) return;

  var status = document.getElementById("save-state");
  var submitBtn = document.getElementById("submit-review");
  var projectId = form.getAttribute("data-project");
  var timer = null;
  var dirty = false;

  function say(text, kind) {
    if (!status) return;
    status.textContent = text;
    status.style.color =
      kind === "bad" ? "var(--bad)" : kind === "good" ? "var(--good)" : "var(--faint)";
  }

  function collect() {
    var scores = {};
    var groups = form.querySelectorAll(".scoregroup");
    for (var i = 0; i < groups.length; i += 1) {
      var key = groups[i].querySelector("input[name^='score-']").name.replace("score-", "");
      var checked = groups[i].querySelector("input:checked");
      if (checked) scores[key] = Number(checked.value);
    }
    var comment = form.querySelector("#comment");
    return { projectId: projectId, scores: scores, comment: comment ? comment.value : "" };
  }

  function send(payload) {
    return fetch("/api/judge/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          return { status: res.status, body: body };
        });
    });
  }

  function saveDraft() {
    if (!dirty) return Promise.resolve();
    dirty = false;
    say("Saving…");
    var payload = collect();
    return send(payload)
      .then(function (r) {
        if (r.status === 200) {
          say("Draft saved", "good");
        } else if (r.status === 403) {
          say("Refused: " + (r.body.message || "not assigned to you"), "bad");
        } else if (r.status === 400) {
          var fields = r.body.fields || {};
          var first = Object.keys(fields)[0];
          say("Refused: " + (first ? first + " — " + fields[first] : r.body.error || "invalid"), "bad");
        } else {
          say("Not saved (" + r.status + ")", "bad");
        }
      })
      .catch(function () {
        dirty = true;
        say("Offline — not saved", "bad");
      });
  }

  function queueSave() {
    dirty = true;
    say("Unsaved changes");
    if (timer) clearTimeout(timer);
    timer = setTimeout(saveDraft, 700);
  }

  form.addEventListener("change", queueSave);
  form.addEventListener("input", queueSave);

  if (submitBtn) {
    submitBtn.addEventListener("click", function () {
      if (timer) clearTimeout(timer);
      var payload = collect();
      payload.submit = true;
      say("Submitting…");
      send(payload)
        .then(function (r) {
          if (r.status === 200) {
            dirty = false;
            say("Submitted. Returning to the queue.", "good");
            setTimeout(function () {
              window.location.href = "/judge";
            }, 600);
          } else if (r.status === 403) {
            say("Refused: " + (r.body.message || "not assigned to you"), "bad");
          } else if (r.status === 400) {
            var fields = r.body.fields || {};
            var first = Object.keys(fields)[0];
            say("Refused: " + (first ? first + " — " + fields[first] : r.body.error), "bad");
          } else {
            say("Not submitted (" + r.status + ")", "bad");
          }
        })
        .catch(function () {
          say("Offline — not submitted", "bad");
        });
    });
  }

  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (submitBtn) submitBtn.click();
      return;
    }
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.key === "j" || e.key === "k") {
      var links = document.querySelectorAll('a[href^="/judge/"]');
      if (!links.length) return;
      var idx = Array.prototype.indexOf.call(links, document.activeElement);
      var next = e.key === "j" ? Math.min(idx + 1, links.length - 1) : Math.max(idx - 1, 0);
      if (idx === -1) next = 0;
      links[next].focus();
      links[next].click();
    }
  });

  // A judge closing the tab mid-edit should not silently lose it. The draft
  // path is fast enough that a beforeunload warning is honest here.
  window.addEventListener("beforeunload", function (e) {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  window.__desk = { collect: collect, saveDraft: saveDraft };
})();
