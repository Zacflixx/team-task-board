/* Team Task Board: front end.
 * Talks to one endpoint, /api/tasks (see netlify/functions/tasks.mjs).
 * Moves and edits show on your screen immediately and are saved in the background.
 * Other people's changes arrive by checking the server every few seconds.
 */
(function () {
  "use strict";

  var STAGES = [
    { id: "todo", name: "Not started", color: "--s-todo" },
    { id: "progress", name: "In progress", color: "--s-prog" },
    { id: "almost", name: "Almost done", color: "--s-almost" },
    { id: "done", name: "Done", color: "--s-done" },
    { id: "live", name: "Live", color: "--s-live" }
  ];
  var STAGE_IDS = STAGES.map(function (s) { return s.id; });
  var POLL_MS = 8000;        // how often to check while the board is active
  var IDLE_POLL_MS = 30000;  // how often once nothing has changed for two minutes
  var ACTIVE_WINDOW_MS = 120000;
  var DEFAULT_OWNERS = ["Isaac", "Kevin", "Maryam", "Soumya"];  // always offered in the Owner field
  var $ = function (s) { return document.querySelector(s); };

  var tasks = [];
  var byId = {};
  var rev = -1;
  var loaded = false;
  var locked = false;
  var offline = false;
  var passcode = lsGet("ttb-passcode");
  var inflight = 0;
  var lastActivity = Date.now();
  var lastPoll = 0;
  var queue = Promise.resolve();
  var dragId = null;
  var pendingRender = false;
  var editingId = null;
  var lastFocus = null;
  var toastTimer = null;
  var delTimer = null;
  var imagesEnabled = false;  // the server says whether Cloudinary is set up
  var MAX_IMAGES = 3;
  var dlgImages = [];         // images attached in the open dialog: [{ id, url }]
  var dlgOriginal = [];       // ids that were already saved on the task when the dialog opened
  var uploading = 0;
  var lbList = [];
  var lbIndex = 0;

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid);
    }
    return el;
  }

  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // Today in the viewer's own time zone, as YYYY-MM-DD (what a date input uses).
  function todayLocal() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }
  // "2026-03-05" -> "Mar 5" (with the year when it is not this year).
  function fmtDate(iso) {
    var p = iso.split("-").map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    var opts = { month: "short", day: "numeric" };
    if (p[0] !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  function stageIndex(id) { return STAGE_IDS.indexOf(id); }

  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4200);
  }

  function setSync(state) {
    var el = $("#sync");
    el.dataset.state = state;
    var labels = {
      connecting: "Connecting",
      synced: "Synced with team",
      offline: "Offline, retrying",
      locked: "Locked"
    };
    el.lastElementChild.textContent = labels[state] || "";
  }

  function hue(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 360;
    return n;
  }
  function initials(name) {
    var parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    var a = Array.from(parts[0])[0] || "";
    var b = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] || "") : "";
    return (a + b).toUpperCase();
  }

  function sorted(list) {
    return list.slice().sort(function (a, b) {
      return (a.order - b.order) || (a.id < b.id ? -1 : 1);
    });
  }
  function column(status, exceptId) {
    return sorted(tasks.filter(function (t) { return t.status === status && t.id !== exceptId; }));
  }

  /* ---------- server ---------- */

  function api(method, body, query, path) {
    var opts = { method: method, cache: "no-store", headers: { "x-team-passcode": passcode } };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch((path || "/api/tasks") + (query || ""), opts).then(function (res) {
      if (res.status === 401) {
        lock();
        var locked401 = new Error("locked");
        locked401.code = "locked";
        throw locked401;
      }
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          var err = new Error(d.error || "Request failed");
          err.code = "http";
          err.status = res.status;
          throw err;
        });
      }
      return res.json();
    }, function () {
      var err = new Error("offline");
      err.code = "offline";
      throw err;
    });
  }

  function normalize(list) {
    return (list || []).map(function (v) {
      return {
        id: String(v.id),
        title: typeof v.title === "string" && v.title ? v.title : "Untitled task",
        notes: typeof v.notes === "string" ? v.notes : "",
        owner: typeof v.owner === "string" ? v.owner : "",
        date: typeof v.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? v.date : "",
        images: (Array.isArray(v.images) ? v.images : []).filter(function (i) {
          return i && typeof i.id === "string" && typeof i.url === "string" && i.url.indexOf("https://res.cloudinary.com/") === 0;
        }).slice(0, MAX_IMAGES).map(function (i) { return { id: i.id, url: i.url }; }),
        status: STAGE_IDS.indexOf(v.status) >= 0 ? v.status : "todo",
        order: typeof v.order === "number" ? v.order : 0
      };
    });
  }

  function rebuildIndex() {
    byId = {};
    tasks.forEach(function (t) { byId[t.id] = t; });
  }

  function apply(d) {
    rev = d.rev;
    imagesEnabled = Boolean(d.features && d.features.images);
    tasks = normalize(d.tasks);
    rebuildIndex();
    loaded = true;
    offline = false;
    locked = false;
    setSync("synced");
    render();
  }

  function refresh() {
    if (!passcode) return Promise.resolve();
    return api("GET", undefined, "?rev=" + rev).then(function (d) {
      if (d.unchanged) { imagesEnabled = Boolean(d.features && d.features.images); offline = false; setSync("synced"); renderStatusOnly(); return; }
      lastActivity = Date.now();
      apply(d);
    }, function (e) {
      if (e.code === "offline") { offline = true; setSync("offline"); renderStatusOnly(); }
    });
  }

  function pollTick(force) {
    if (document.hidden || dragId || inflight > 0 || locked || !passcode) return;
    var now = Date.now();
    var gap = now - lastActivity < ACTIVE_WINDOW_MS ? POLL_MS : IDLE_POLL_MS;
    if (!force && now - lastPoll < gap) return;
    lastPoll = now;
    refresh();
  }

  function enqueue(fn) {
    lastActivity = Date.now();
    inflight++;
    var p = queue.then(fn);
    queue = p.catch(function () {});
    return p.then(function (r) { inflight--; return r; }, function (e) { inflight--; throw e; });
  }

  function settle(d) {
    // Only take the server's list once every queued write has finished,
    // so a late reply never undoes a move you made a moment later.
    if (inflight === 0) apply(d);
    else rev = d.rev;
  }

  function writeError(e) {
    if (e.code === "locked") return;
    if (e.code === "offline") toast("No connection. That change wasn't saved.");
    else if (e.status === 404) toast("Someone else already removed that task.");
    else if (e.status === 400 || e.status === 409) toast(e.message);
    else toast("Couldn't save that change. Try again in a moment.");
  }

  function failed(e) {
    writeError(e);
    rev = -1;
    refresh();
  }

  function updateTask(id, patch) {
    tasks = tasks.map(function (t) { return t.id === id ? Object.assign({}, t, patch) : t; });
    rebuildIndex();
    render();
    return enqueue(function () { return api("PATCH", { id: id, patch: patch }); })
      .then(function (d) { settle(d); return true; }, function (e) { failed(e); return false; });
  }

  function deleteTask(id) {
    tasks = tasks.filter(function (t) { return t.id !== id; });
    rebuildIndex();
    render();
    return enqueue(function () { return api("DELETE", { id: id }); })
      .then(function (d) { settle(d); toast("Task deleted."); return true; }, function (e) { failed(e); return false; });
  }

  /* ---------- passcode gate ---------- */

  function lock() {
    locked = true;
    passcode = "";
    lsSet("ttb-passcode", "");
    setSync("locked");
    $("#gate").hidden = false;
    $("#overlay").hidden = true;
    render();
    setTimeout(function () { $("#gatePass").focus(); }, 0);
  }

  $("#gateForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var value = $("#gatePass").value;
    if (!value) { $("#gateErr").textContent = "Enter the passcode."; return; }
    var btn = $("#gateBtn");
    btn.disabled = true;
    $("#gateErr").textContent = "";
    passcode = value;
    rev = -1;
    api("GET").then(function (d) {
      btn.disabled = false;
      lsSet("ttb-passcode", value);
      $("#gatePass").value = "";
      $("#gate").hidden = true;
      apply(d);
    }, function (err) {
      btn.disabled = false;
      $("#gateErr").textContent = err.code === "offline"
        ? "Can't reach the server. Check your connection."
        : (err.code === "locked" ? "That passcode didn't work." : err.message);
    });
  });

  /* ---------- rendering ---------- */

  function renderSummary() {
    var total = tasks.length;
    var open = tasks.filter(function (t) { return t.status !== "done" && t.status !== "live"; }).length;
    var live = tasks.filter(function (t) { return t.status === "live"; }).length;
    var text;
    if (!total) text = loaded ? "Nothing tracked yet" : (locked ? "Locked" : (offline ? "Can't reach the board" : "Loading tasks"));
    else text = total + (total === 1 ? " task" : " tasks") + " · " + open + " open · " + live + " live";
    $("#summary").textContent = text;
  }

  function renderEmpty() {
    var box = $("#empty");
    if (tasks.length) { box.hidden = true; return; }
    box.hidden = false;
    var btn = $("#emptyBtn");
    if (loaded) {
      $("#emptyTitle").textContent = "No tasks yet";
      $("#emptyText").textContent = "Add the first one. Everyone with the passcode sees it within a few seconds.";
      btn.hidden = false;
    } else {
      btn.hidden = true;
      if (locked) {
        $("#emptyTitle").textContent = "The board is locked";
        $("#emptyText").textContent = "Enter the team passcode to see the tasks.";
      } else if (offline) {
        $("#emptyTitle").textContent = "Can't reach the board";
        $("#emptyText").textContent = "Check your connection. This page keeps trying.";
      } else {
        $("#emptyTitle").textContent = "Loading the team's tasks";
        $("#emptyText").textContent = "This takes a moment.";
      }
    }
  }

  function renderStatusOnly() { renderSummary(); renderEmpty(); }

  function fillOwners() {
    var seen = {};
    var dl = $("#owners");
    dl.replaceChildren();
    // The default team members first, then any other name already used on the board.
    DEFAULT_OWNERS.concat(tasks.map(function (t) { return t.owner; })).forEach(function (name) {
      var key = name.toLowerCase();
      if (name && !seen[key]) { seen[key] = 1; dl.append(h("option", { value: name })); }
    });
  }

  // One-click owner names under the Owner field.
  function buildOwnerChips() {
    var box = $("#ownerChips");
    DEFAULT_OWNERS.forEach(function (name) {
      box.append(h("button", {
        type: "button", class: "chip", text: name,
        onclick: function () { $("#fOwner").value = name; $("#fOwner").focus(); }
      }));
    });
  }

  function render() {
    if (dragId) { pendingRender = true; return; }
    pendingRender = false;
    var board = $("#board");
    var scroll = board.scrollLeft;
    board.replaceChildren();

    STAGES.forEach(function (s) {
      var items = column(s.id);
      var list = h("div", { class: "list" });
      var col = h("section", { class: "col", "data-status": s.id, "aria-label": s.name },
        h("div", { class: "col-head" },
          h("span", { class: "dot" }),
          h("h2", { class: "col-name", text: s.name }),
          h("span", { class: "count", text: String(items.length) }),
          h("button", { type: "button", class: "iconbtn", "aria-label": "Add a task to " + s.name, title: "Add a task here", text: "+", onclick: function () { openDialog(null, s.id); } })
        ),
        list
      );
      col.style.setProperty("--stage", "var(" + s.color + ")");

      if (!items.length) list.append(h("p", { class: "hint", text: "Drop a task here or press +" }));
      items.forEach(function (t) { list.append(cardEl(t)); });

      list.addEventListener("dragover", function (e) { onDragOver(e, list, col, s.id); });
      list.addEventListener("drop", function (e) { onDrop(e, s.id); });
      col.addEventListener("dragleave", function (e) {
        if (!col.contains(e.relatedTarget)) col.classList.remove("over");
      });
      board.append(col);
    });

    board.scrollLeft = scroll;
    renderSummary();
    renderEmpty();
    fillOwners();
  }

  function cardEl(t) {
    var idx = stageIndex(t.status);
    var card = h("div", {
      class: "card", tabindex: "0", role: "button", "data-id": t.id,
      "aria-label": "Open task: " + t.title,
      draggable: "true"
    });
    card.append(h("h3", { text: t.title }));
    if (t.notes) card.append(h("p", { class: "notes", text: t.notes }));
    if (t.images.length) {
      var thumbs = h("div", { class: "thumbs" });
      t.images.forEach(function (im, n) {
        thumbs.append(h("button", {
          type: "button", class: "thumb", "aria-label": "View image " + (n + 1) + " of " + t.images.length,
          onclick: function (e) { e.stopPropagation(); openLightbox(t.images, n); }
        }, h("img", { src: thumbUrl(im.url), alt: "", loading: "lazy", draggable: "false" })));
      });
      card.append(thumbs);
    }

    var foot = h("div", { class: "card-foot" });
    if (t.owner) {
      var av = h("span", { class: "avatar", text: initials(t.owner), "aria-hidden": "true" });
      av.style.setProperty("--h", String(hue(t.owner)));
      foot.append(h("span", { class: "owner" }, av, h("b", { text: t.owner })));
    }
    if (t.date) foot.append(h("span", { class: "date", text: fmtDate(t.date), title: "Date: " + t.date }));
    var prev = idx > 0 ? STAGES[idx - 1] : null;
    var next = idx < STAGES.length - 1 ? STAGES[idx + 1] : null;
    foot.append(h("span", { class: "moves" },
      h("button", { type: "button", class: "iconbtn", text: "‹", disabled: prev ? null : true, "aria-label": prev ? "Move back to " + prev.name : "Already at the first stage", title: prev ? "Move back to " + prev.name : "", onclick: function (e) { e.stopPropagation(); if (prev) step(t, prev.id); } }),
      h("button", { type: "button", class: "iconbtn", text: "›", disabled: next ? null : true, "aria-label": next ? "Move forward to " + next.name : "Already at the last stage", title: next ? "Move forward to " + next.name : "", onclick: function (e) { e.stopPropagation(); if (next) step(t, next.id); } })
    ));
    card.append(foot);

    card.addEventListener("click", function (e) {
      if (e.target.closest(".moves")) return;
      openDialog(t.id);
    });
    card.addEventListener("keydown", function (e) {
      if (e.target !== card) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(t.id); }
    });
    card.addEventListener("dragstart", function (e) {
      dragId = t.id;
      e.dataTransfer.setData("text/plain", t.id);
      e.dataTransfer.effectAllowed = "move";
      setTimeout(function () { card.classList.add("dragging"); }, 0);
    });
    card.addEventListener("dragend", function () {
      dragId = null;
      clearDragUi();
      if (pendingRender) render();
    });
    return card;
  }

  /* ---------- drag and drop ---------- */

  var placeholder = h("div", { class: "drop-line" });

  function clearDragUi() {
    if (placeholder.parentNode) placeholder.remove();
    document.querySelectorAll(".col.over").forEach(function (c) { c.classList.remove("over"); });
    document.querySelectorAll(".card.dragging").forEach(function (c) { c.classList.remove("dragging"); });
  }

  function autoscroll(e) {
    var board = $("#board");
    var r = board.getBoundingClientRect();
    if (e.clientX < r.left + 60) board.scrollLeft -= 18;
    else if (e.clientX > r.right - 60) board.scrollLeft += 18;
  }

  function onDragOver(e, list, col, status) {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    autoscroll(e);
    document.querySelectorAll(".col.over").forEach(function (c) { if (c !== col) c.classList.remove("over"); });
    col.classList.add("over");
    var cards = Array.prototype.filter.call(list.querySelectorAll(".card"), function (c) { return c.dataset.id !== dragId; });
    var before = null;
    for (var i = 0; i < cards.length; i++) {
      var r = cards[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { before = cards[i]; break; }
    }
    if (before) list.insertBefore(placeholder, before);
    else list.append(placeholder);
    placeholder.dataset.status = status;
  }

  function neighborCard(el, dir) {
    var n = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    while (n && (!n.classList.contains("card") || n.classList.contains("dragging"))) {
      n = dir < 0 ? n.previousElementSibling : n.nextElementSibling;
    }
    return n;
  }

  function onDrop(e, status) {
    if (!dragId) return;
    e.preventDefault();
    var id = dragId;
    var t = byId[id];
    var prevEl = placeholder.parentNode ? neighborCard(placeholder, -1) : null;
    var nextEl = placeholder.parentNode ? neighborCard(placeholder, 1) : null;
    clearDragUi();
    if (!t) return;
    var others = column(status, id);
    var prev = prevEl ? byId[prevEl.dataset.id] : null;
    var next = nextEl ? byId[nextEl.dataset.id] : null;

    if (t.status === status) {
      var seq = others.map(function (x) { return x.id; });
      var at = next ? seq.indexOf(next.id) : seq.length;
      if (at < 0) at = seq.length;
      seq.splice(at, 0, id);
      var now = column(status).map(function (x) { return x.id; });
      if (seq.join("|") === now.join("|")) return;
    }

    var order;
    if (prev && next) order = (prev.order + next.order) / 2;
    else if (prev) order = prev.order + 1;
    else if (next) order = next.order - 1;
    else order = Date.now();
    var patch = { status: status, order: order };
    if (t.status !== status) patch.date = todayLocal();  // a real move stamps the date
    updateTask(id, patch);
  }

  function step(t, status) {
    updateTask(t.id, { status: status, order: Date.now(), date: todayLocal() });
  }

  /* ---------- images (stored on Cloudinary) ---------- */

  // Cloudinary resizes and compresses on delivery: insert a transformation into the stored link.
  function transformed(url, t) { return url.replace("/image/upload/", "/image/upload/" + t + "/"); }
  function thumbUrl(url) { return transformed(url, "c_fill,w_320,h_200,f_auto,q_auto"); }
  function fullUrl(url) { return transformed(url, "c_limit,w_1600,f_auto,q_auto"); }

  // Shrink before uploading (longest side 1600px, WebP or JPEG) so storage stays small.
  function shrink(file) {
    return createImageBitmap(file).then(function (bmp) {
      var scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      if (bmp.close) bmp.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (webp) {
          if (webp && webp.type === "image/webp") return resolve(webp);
          canvas.toBlob(function (jpg) { jpg ? resolve(jpg) : reject(new Error("shrink")); }, "image/jpeg", 0.85);
        }, "image/webp", 0.82);
      });
    });
  }

  function uploadImage(file) {
    return shrink(file).then(function (blob) {
      return api("POST", undefined, "", "/api/images").then(function (p) {
        var fd = new FormData();
        fd.append("file", blob, blob.type === "image/webp" ? "image.webp" : "image.jpg");
        fd.append("api_key", p.apiKey);
        fd.append("timestamp", String(p.timestamp));
        fd.append("signature", p.signature);
        fd.append("folder", p.folder);
        fd.append("allowed_formats", p.allowed_formats);
        return fetch(p.uploadUrl, { method: "POST", body: fd });
      });
    }).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok || !j.public_id) throw new Error((j.error && j.error.message) || "Upload failed");
        return { id: j.public_id, url: j.secure_url };
      });
    });
  }

  function addFiles(files) {
    Array.prototype.forEach.call(files, function (file) {
      if (!/^image\//.test(file.type)) { toast("Only images can be attached."); return; }
      if (dlgImages.length + uploading >= MAX_IMAGES) { toast("Up to " + MAX_IMAGES + " images per task."); return; }
      uploading++;
      renderDlgImages();
      uploadImage(file).then(function (img) {
        if ($("#overlay").hidden) discardImages([img]);  // dialog was closed while uploading
        else dlgImages.push(img);
      }, function (e) {
        if (e && e.code === "locked") return;
        console.error("Image upload failed:", e);
        var why = e && e.message ? " (" + String(e.message).slice(0, 120) + ")" : "";
        toast(e && e.status === 501 ? "Images are not set up yet." : "Couldn't upload that image" + why);
      }).then(function () { uploading--; renderDlgImages(); });
    });
  }

  // Free uploads that never got attached to a saved task.
  function discardImages(list) {
    list.forEach(function (im) {
      api("DELETE", { id: im.id }, "", "/api/images").catch(function () {});
    });
  }

  function renderDlgImages() {
    $("#imgField").hidden = !imagesEnabled;
    var grid = $("#imgGrid");
    grid.replaceChildren();
    dlgImages.forEach(function (im) {
      grid.append(h("div", { class: "img-item" },
        h("img", { src: thumbUrl(im.url), alt: "Attached image" }),
        h("button", {
          type: "button", class: "img-x", "aria-label": "Remove image", text: "×",
          onclick: function () {
            dlgImages = dlgImages.filter(function (x) { return x.id !== im.id; });
            if (dlgOriginal.indexOf(im.id) < 0) discardImages([im]);  // not saved yet, so free it now
            renderDlgImages();
          }
        })
      ));
    });
    for (var i = 0; i < uploading; i++) grid.append(h("div", { class: "img-item img-up", text: "Uploading…" }));
    $("#imgBtn").disabled = dlgImages.length + uploading >= MAX_IMAGES;
  }

  function showLightbox() {
    $("#lbImg").src = fullUrl(lbList[lbIndex].url);
    $("#lbPrev").hidden = $("#lbNext").hidden = lbList.length < 2;
    $("#lbCount").textContent = lbList.length > 1 ? (lbIndex + 1) + " / " + lbList.length : "";
  }
  function openLightbox(list, index) {
    lbList = list;
    lbIndex = index;
    $("#lightbox").hidden = false;
    showLightbox();
  }
  function closeLightbox() { $("#lightbox").hidden = true; $("#lbImg").removeAttribute("src"); }
  function stepLightbox(by) {
    lbIndex = (lbIndex + by + lbList.length) % lbList.length;
    showLightbox();
  }
  $("#lbClose").addEventListener("click", closeLightbox);
  $("#lbPrev").addEventListener("click", function () { stepLightbox(-1); });
  $("#lbNext").addEventListener("click", function () { stepLightbox(1); });
  $("#lightbox").addEventListener("mousedown", function (e) { if (e.target === $("#lightbox")) closeLightbox(); });

  $("#imgBtn").addEventListener("click", function () { $("#imgFile").click(); });
  $("#imgFile").addEventListener("change", function (e) { addFiles(e.target.files); e.target.value = ""; });
  // Paste a screenshot straight into the dialog.
  $("#form").addEventListener("paste", function (e) {
    if (!imagesEnabled || !e.clipboardData) return;
    var files = Array.prototype.filter.call(e.clipboardData.items, function (i) { return i.kind === "file" && /^image\//.test(i.type); })
      .map(function (i) { return i.getAsFile(); });
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  // Dropping image files onto the image area works too (card dragging is unaffected).
  $("#imgField").addEventListener("dragover", function (e) { if (imagesEnabled && !dragId) e.preventDefault(); });
  $("#imgField").addEventListener("drop", function (e) {
    if (!imagesEnabled || dragId) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });

  /* ---------- add and edit dialog ---------- */

  function openDialog(id, status) {
    var t = id ? byId[id] : null;
    if (id && !t) return;
    editingId = id;
    lastFocus = document.activeElement;
    var sel = $("#fStatus");
    sel.replaceChildren();
    STAGES.forEach(function (s) { sel.append(h("option", { value: s.id, text: s.name })); });

    $("#dlgTitle").textContent = t ? "Edit task" : "New task";
    $("#fTitle").value = t ? t.title : "";
    $("#fNotes").value = t ? t.notes : "";
    $("#fOwner").value = t ? t.owner : lsGet("ttb-owner");
    sel.value = t ? t.status : (status || "todo");
    $("#fDate").value = t ? t.date : "";
    dlgImages = t ? t.images.slice() : [];
    dlgOriginal = dlgImages.map(function (i) { return i.id; });
    uploading = 0;
    renderDlgImages();
    $("#fErr").textContent = "";
    $("#saveBtn").disabled = false;
    resetDelete();
    $("#delBtn").hidden = !t;
    $("#overlay").hidden = false;
    setTimeout(function () { $("#fTitle").focus(); }, 0);
  }

  // keep === true means the task was saved with these images; otherwise free any new uploads.
  function closeDialog(keep) {
    if (keep !== true) {
      discardImages(dlgImages.filter(function (i) { return dlgOriginal.indexOf(i.id) < 0; }));
    }
    dlgImages = [];
    $("#overlay").hidden = true;
    editingId = null;
    resetDelete();
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  }

  function resetDelete() {
    clearTimeout(delTimer);
    var b = $("#delBtn");
    b.classList.remove("armed");
    b.textContent = "Delete task";
  }

  $("#form").addEventListener("submit", function (e) {
    e.preventDefault();
    var title = $("#fTitle").value.trim();
    if (!title) { $("#fErr").textContent = "Give the task a title."; $("#fTitle").focus(); return; }
    var notes = $("#fNotes").value.trim();
    var owner = $("#fOwner").value.trim();
    var status = $("#fStatus").value;
    var date = $("#fDate").value;
    if (uploading > 0) { $("#fErr").textContent = "Wait for the image to finish uploading."; return; }
    if (STAGE_IDS.indexOf(status) < 0) status = "todo";
    lsSet("ttb-owner", owner);

    if (editingId) {
      var cur = byId[editingId];
      var patch = { title: title, notes: notes, owner: owner, status: status, date: date };
      if (imagesEnabled) patch.images = dlgImages;
      if (cur && cur.status !== status) {
        patch.order = Date.now();
        // Moving stage stamps today, unless the date was changed by hand in this dialog.
        if (date === cur.date) patch.date = todayLocal();
      }
      var id = editingId;
      closeDialog(true);
      updateTask(id, patch);
      return;
    }

    var btn = $("#saveBtn");
    btn.disabled = true;
    var body = { title: title, notes: notes, owner: owner, status: status, date: date };
    if (imagesEnabled) body.images = dlgImages;
    enqueue(function () { return api("POST", body); })
      .then(function (d) { settle(d); closeDialog(true); }, function (err) { btn.disabled = false; writeError(err); });
  });

  $("#delBtn").addEventListener("click", function () {
    var b = $("#delBtn");
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      b.textContent = "Click again to delete";
      delTimer = setTimeout(resetDelete, 4000);
      return;
    }
    var id = editingId;
    closeDialog();
    if (id) deleteTask(id);
  });

  $("#cancelBtn").addEventListener("click", function () { closeDialog(false); });
  $("#overlay").addEventListener("mousedown", function (e) { if (e.target === $("#overlay")) closeDialog(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!$("#lightbox").hidden) closeLightbox();
      else if (!$("#overlay").hidden) closeDialog(false);
    } else if (!$("#lightbox").hidden && (e.key === "ArrowLeft" || e.key === "ArrowRight") && lbList.length > 1) {
      stepLightbox(e.key === "ArrowLeft" ? -1 : 1);
    }
  });
  $("#addBtn").addEventListener("click", function () { openDialog(null, "todo"); });
  $("#emptyBtn").addEventListener("click", function () { openDialog(null, "todo"); });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    lastActivity = Date.now();
    pollTick(true);
  });
  setInterval(function () { pollTick(false); }, 2000);

  /* ---------- start ---------- */

  buildOwnerChips();
  render();
  if (passcode) {
    setSync("connecting");
    refresh();
  } else {
    lock();
  }
})();
