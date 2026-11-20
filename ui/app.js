/* leverframe cabinet-lite — signal box renderer (v1: live/down/idle, invoke GO-gated) */
(function () {
  "use strict";

  var ET = "America/New_York";
  var sessionStartTs = Date.now();

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function etParts(d) {
    var f = new Intl.DateTimeFormat("en-GB", {
      timeZone: ET,
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    var p = {};
    f.formatToParts(d).forEach(function (x) {
      p[x.type] = x.value;
    });
    return p;
  }

  function etTime(d) {
    return etParts(d).hour === "24"
      ? etTime(new Date(d.getTime() - 1000))
      : etParts(d).hour + ":" + etParts(d).minute + ":" + etParts(d).second;
  }

  function etDateLine(d) {
    var p = etParts(d);
    return (p.weekday + " " + p.day + " " + p.month + " " + p.year + " · ET").toUpperCase();
  }

  /* ET midnight (as a UTC ms timestamp): derive the current ET→UTC offset from wall parts */
  function etDayStartMs(d) {
    var p = etParts(d);
    var wallAsUtc = Date.UTC(
      Number(p.year),
      { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }[p.month],
      Number(p.day),
      Number(p.hour === "24" ? 0 : p.hour),
      Number(p.minute),
      Number(p.second)
    );
    var offsetMs = wallAsUtc - d.getTime();
    return Date.UTC(Number(p.year), { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }[p.month], Number(p.day)) - offsetMs;
  }

  function fmtMs(ms) {
    return (ms / 1000).toFixed(1) + "s";
  }

  function fmtP95(entries) {
    if (!entries.length) return "—";
    var ms = entries.map(function (e) { return e.ms; }).sort(function (a, b) { return a - b; });
    var idx = Math.max(0, Math.ceil(ms.length * 0.95) - 1);
    return fmtMs(ms[idx]);
  }

  var BADGE = { openclaw: ["b-oc", "OPENCLAW"], hermes: ["b-he", "HERMES"], mcp: ["b-mcp", "MCP"] };

  function renderAttention(snap, counts) {
    var el = document.getElementById("attention");
    var plate = snap.plates && snap.plates.needs_you;
    if (!plate) return;
    if (plate.ok && Array.isArray(plate.tasks) && plate.tasks.length > 0) {
      var chips = plate.tasks
        .map(function (t) {
          return '<span class="att-item"><b>' + esc(t.assigned_to) + "</b> <span class=\"sp-dim\">" + esc(t.title) + "</span></span>";
        })
        .join("");
      el.className = "attention";
      el.innerHTML =
        '<span class="att-label">NEEDS YOU</span>' + chips +
        '<span class="att-cta">' + plate.tasks.length + " ITEMS →</span>";
    } else if (plate.ok) {
      el.className = "attention clear";
      el.innerHTML =
        '<span class="att-label">NEEDS YOU</span><span class="sp-dim">nothing. interlock clear — ' +
        counts.healthyRoutes + " levers healthy, 0 conflicts.</span>";
    } else {
      el.className = "attention off";
      el.innerHTML =
        '<span class="att-label">NEEDS YOU</span><span class="att-off-text">cabinet offline — ' + esc(plate.error) + "</span>";
    }
  }

  function renderTiles(snap) {
    var el = document.getElementById("tiles");
    var roster = snap.roster || { openclaw: [], hermes: [] };
    var health = snap.health || {};
    var out = [];
    (roster.openclaw || []).forEach(function (a) {
      var h = health[a.name];
      var state = "idle";
      if (h && h.error) state = "down";
      else if (h && !h.error && h.ok) state = "live";
      var slot = state === "live" ? '<i></i>' : '<i class="dark"></i>';
      out.push(
        '<div class="tile' + (state === "down" ? " down" : "") + '"><span class="st ' + state + '"></span>' +
        '<div class="tile-name">' + esc(a.name) + '</div><div class="tile-role">' + esc(a.role) + "</div>" +
        '<div class="slot">' + slot + '<span class="ball"></span></div><span class="tile-tag">oc</span></div>'
      );
    });
    (roster.hermes || []).forEach(function (h) {
      out.push(
        '<div class="tile"><span class="st idle"></span>' +
        '<div class="tile-name">' + esc(h.name) + '</div><div class="tile-role">' + esc(h.role) + "</div>" +
        '<div class="slot"><i class="dark"></i><span class="ball"></span></div><span class="tile-tag">he</span></div>'
      );
    });
    el.innerHTML = out.join("") ||
      '<div class="fi-empty" style="grid-column:1/-1">no levers in the frame — roster empty.</div>';
  }

  function renderRhythm(feed) {
    var el = document.getElementById("rhythm");
    var now = Date.now();
    var BUCKET_MS = 30 * 60 * 1000;
    var N = 48;
    var counts = new Array(N).fill(0);
    var hot = new Array(N).fill(false);
    (feed || []).forEach(function (e) {
      var idx = Math.floor((now - e.ts) / BUCKET_MS);
      if (idx >= 0 && idx < N) {
        counts[idx] += 1;
        if (!e.ok) hot[idx] = true;
      }
    });
    var max = Math.max.apply(null, counts);
    var bars = [];
    for (var i = N - 1; i >= 0; i--) {
      var pct = counts[i] === 0 ? 0 : Math.max(8, Math.round((counts[i] / max) * 100));
      var cls = counts[i] === 0 ? "" : hot[i] ? "hot" : "on";
      if (i === 0) cls += (cls ? " " : "") + "cur";
      bars.push('<i class="' + cls + '" style="height:' + pct + '%"></i>');
    }
    el.innerHTML = bars.join("");
  }

  function renderFeed(snap) {
    var el = document.getElementById("feed");
    var digestEl = document.getElementById("digest");
    var feed = snap.feed || [];
    var sessionFails = feed.filter(function (e) {
      return e.ts > sessionStartTs && !e.ok;
    }).length;
    if (sessionFails > 0) {
      digestEl.className = "digest";
      digestEl.innerHTML =
        "while you were away — <b>" + sessionFails + "</b> failure" + (sessionFails === 1 ? "" : "s") +
        " since you opened this box.";
    } else {
      digestEl.className = "digest hidden";
      digestEl.innerHTML = "";
    }
    if (!feed.length) {
      el.innerHTML = '<div class="fi-empty">no pulls yet — the box is quiet.</div>';
      return;
    }
    el.innerHTML = feed
      .map(function (e) {
        var badge = BADGE[e.runtime] || BADGE.mcp;
        var err = !e.ok;
        return (
          '<div class="fi' + (err ? " fi-err" : "") + '"><span class="fi-time">' + esc(etTime(new Date(e.ts))) +
          '</span><span class="fi-agent">' + esc(e.agent) +
          '</span><span class="fi-badge ' + badge[0] + '">' + badge[1] + "</span>" +
          '<span class="fi-prompt">' + esc(e.summary) + "</span>" +
          '<span class="fi-ms">' + fmtMs(e.ms) + "</span>" +
          (err ? '<span class="fi-link">context →</span>' : "") +
          "</div>"
        );
      })
      .join("");
  }

  function renderInvoke(snap) {
    var sel = document.getElementById("inv-agent");
    var agents = (snap.roster && snap.roster.openclaw) || [];
    var prev = sel.value; /* preserve selection across re-renders */
    if (!agents.length) {
      sel.innerHTML = '<option>—</option>';
      return;
    }
    sel.innerHTML = agents
      .map(function (a) {
        return "<option>" + esc(a.name) + "</option>";
      })
      .join("");
    var stillThere = Array.prototype.some.call(sel.options, function (o) {
      return o.value === prev;
    });
    sel.value = stillThere ? prev : sel.options[0].value;
  }

  function renderSide(snap, feed, counts) {
    document.getElementById("il-routes").innerHTML =
      counts.healthyRoutes + '<span class="u"> / ' + counts.totalRoutes + " ROUTES</span>";
    document.getElementById("il-free").textContent = String(counts.leversFree);
    document.getElementById("pulls-num").textContent = String(feed.length);
    document.getElementById("pulls-p95").textContent = fmtP95(feed);
    document.getElementById("pulls-fail").textContent = String(
      feed.filter(function (e) { return !e.ok; }).length
    );
    var roster = (snap.roster || { openclaw: [], hermes: [] });
    document.getElementById("rt-oc").textContent = String((roster.openclaw || []).length);
    document.getElementById("rt-he").textContent = String((roster.hermes || []).length);
    var mcpAgents = {};
    feed.forEach(function (e) {
      if (e.runtime === "mcp") mcpAgents[e.agent] = 1;
    });
    document.getElementById("rt-mcp").textContent = String(Object.keys(mcpAgents).length);
  }

  function renderTopDigest(feed) {
    var el = document.getElementById("top-digest");
    var dayStart = etDayStartMs(new Date());
    var today = feed.filter(function (e) { return e.ts >= dayStart; });
    var fails = today.filter(function (e) { return !e.ok; });
    var escal = today.filter(function (e) {
      return !e.ok && /needs_human|escalat/i.test(e.summary || "");
    });
    function plural(n, word) {
      return "<b>" + n + "</b> " + word + (n === 1 ? "" : "s");
    }
    el.innerHTML =
      "since 00:00 — " + plural(today.length, "pull") + " · " + plural(fails.length, "failure") +
      " · " + plural(escal.length, "escalation");
  }

  function computeCounts(snap) {
    var roster = snap.roster || { openclaw: [], hermes: [] };
    var health = snap.health || {};
    var healthyOc = (roster.openclaw || []).filter(function (a) {
      var h = health[a.name];
      return h && !h.error && h.ok;
    }).length;
    var heCount = (roster.hermes || []).length;
    var downCount = (roster.openclaw || []).filter(function (a) {
      var h = health[a.name];
      return h && h.error;
    }).length;
    return {
      healthyRoutes: healthyOc + heCount,
      totalRoutes: (roster.openclaw || []).length + heCount,
      leversFree: downCount,
    };
  }

  var lastRaw = null;
  function render(raw) {
    if (raw === lastRaw) return;
    lastRaw = raw;
    var snap;
    try {
      snap = JSON.parse(raw);
    } catch (err) {
      return;
    }
    try {
      var feed = snap.feed || [];
      var counts = computeCounts(snap);
      renderTopDigest(feed);
      renderAttention(snap, counts);
      renderTiles(snap);
      renderRhythm(feed);
      renderFeed(snap);
      renderInvoke(snap);
      renderSide(snap, feed, counts);
    } catch (err) {
      /* a bad frame must never take the box down — next snapshot re-renders */
    }
  }

  function tickClock() {
    var d = new Date();
    document.getElementById("clock-t").textContent = etTime(d);
    document.getElementById("clock-d").textContent = etDateLine(d);
  }

  tickClock();
  setInterval(tickClock, 1000);

  var es = new EventSource("/api/stream");
  es.addEventListener("snapshot", function (ev) {
    render(ev.data);
  });
})();
