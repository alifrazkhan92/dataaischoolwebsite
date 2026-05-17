/**
 * The Data and AI School of London
 * Admission form: file uploads (drag-drop + click), validation,
 * base64 encoding, and submission via hidden iframe + form POST.
 *
 * fetch() + no-cors does not work for Apps Script because the redirect
 * from script.google.com drops the POST body. Native form POST handles
 * the redirect correctly and delivers e.parameter to Apps Script.
 */

(function () {
  'use strict';

  var SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx9l0k_djg4F2nbeGYifKUWzsvAKe5uMM7l_PgbQrXK9OR7U0ivtIDiq5HiyMuxugVq1g/exec';

  // ── DOB max (applicant must be 16+) ─────────────────────────────────────────
  (function setDobMax() {
    var d = new Date();
    d.setFullYear(d.getFullYear() - 16);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    document.getElementById('dob').max =
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  })();

  // ── Disability conditional fields ────────────────────────────────────────────
  document.getElementById('disability').addEventListener('change', function () {
    var show = this.value === 'Yes, see below';
    document.getElementById('disability-type-row').style.display = show ? '' : 'none';
    document.getElementById('access-row').style.display = show ? '' : 'none';
    document.getElementById('disabilityType').required = show;
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function fmtBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  function showErr(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
    var fg = el.closest('.form-group');
    if (fg) fg.classList.add('has-error');
  }

  function clearErr(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = '';
    el.classList.remove('visible');
    var fg = el.closest('.form-group');
    if (fg) fg.classList.remove('has-error');
  }

  function showBanner(msg) {
    var b = document.getElementById('adm-error-banner');
    b.textContent = msg;
    b.classList.add('visible');
    b.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function hideBanner() {
    var b = document.getElementById('adm-error-banner');
    b.textContent = '';
    b.classList.remove('visible');
  }

  // ── File upload zone setup ───────────────────────────────────────────────────
  var ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

  function setupZone(zoneId, inputId, previewId, nameId, sizeId, isImage) {
    var zone    = document.getElementById(zoneId);
    var input   = document.getElementById(inputId);
    var preview = document.getElementById(previewId);
    var nameEl  = document.getElementById(nameId);
    var sizeEl  = document.getElementById(sizeId);
    var maxMb   = parseFloat(input.dataset.maxMb || '10');

    if (!zone || !input) return;

    zone.addEventListener('click', function (e) {
      if (!e.target.closest('.upload-remove-btn')) input.click();
    });

    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });

    zone.addEventListener('dragover',  function (e) { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', function ()  { zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });

    input.addEventListener('change', function () {
      if (input.files.length) handleFile(input.files[0]);
    });

    zone.addEventListener('click', function (e) {
      if (e.target.closest('.upload-remove-btn')) {
        input.value = '';
        zone.querySelector('.upload-placeholder').style.display = '';
        preview.classList.remove('visible');
      }
    });

    function handleFile(file) {
      // Size check
      if (file.size > maxMb * 1024 * 1024) {
        alert('File too large. Maximum ' + maxMb + ' MB for this field.');
        input.value = '';
        return;
      }

      // MIME type check -- block disallowed types (server-side also validates)
      if (ALLOWED_TYPES.indexOf(file.type) === -1) {
        alert('Invalid file type. Accepted formats: JPG, PNG, WebP, PDF.');
        input.value = '';
        return;
      }

      nameEl.textContent = file.name;
      sizeEl.textContent = fmtBytes(file.size);

      if (isImage && file.type.startsWith('image/')) {
        var img    = preview.querySelector('.upload-preview-img');
        var reader = new FileReader();
        reader.onload = function (ev) { img.src = ev.target.result; };
        reader.readAsDataURL(file);
      } else {
        var icon = preview.querySelector('.upload-file-icon');
        if (icon) icon.textContent = file.name.endsWith('.pdf') ? '📄' : '📎';
      }

      zone.querySelector('.upload-placeholder').style.display = 'none';
      preview.classList.add('visible');
    }
  }

  setupZone('photo-zone', 'photo-input', 'photo-preview', 'photo-name', 'photo-size', true);
  setupZone('id-zone',    'id-input',    'id-preview',    'id-name',    'id-size',    false);
  setupZone('qual-zone',  'qual-input',  'qual-preview',  'qual-name',  'qual-size',  false);

  // ── Extra document rows ──────────────────────────────────────────────────────
  var extraDocCount = 0;
  document.getElementById('add-extra-doc').addEventListener('click', function () {
    if (extraDocCount >= 3) {
      this.disabled = true;
      this.textContent = 'Maximum 3 additional documents';
      return;
    }
    extraDocCount++;
    var idx    = extraDocCount;
    var rowId  = 'extra-row-'   + idx;
    var zoneId = 'extra-zone-'  + idx;
    var inputId= 'extra-input-' + idx;
    var prevId = 'extra-prev-'  + idx;
    var nameId = 'extra-name-'  + idx;
    var sizeId = 'extra-size-'  + idx;

    var row = document.createElement('div');
    row.className = 'extra-doc-row';
    row.id = rowId;

    // Build row DOM with createElement to avoid innerHTML injection risk
    var zone = document.createElement('div');
    zone.className = 'upload-zone';
    zone.id = zoneId;
    zone.setAttribute('role', 'button');
    zone.setAttribute('tabindex', '0');
    zone.setAttribute('aria-label', 'Upload additional document ' + idx);

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = inputId;
    fileInput.className = 'extra-doc-input';
    fileInput.accept = 'image/jpeg,image/png,image/webp,application/pdf';
    fileInput.dataset.maxMb = '10';

    var placeholder = document.createElement('div');
    placeholder.className = 'upload-placeholder';
    placeholder.innerHTML =
      '<svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
      '<polyline points="14 2 14 8 20 8"/></svg>' +
      '<p class="upload-label-text">Document ' + idx + ', click or drag &amp; drop</p>' +
      '<p class="upload-hint-text">JPG, PNG or PDF · Max 10 MB</p>';

    var previewArea = document.createElement('div');
    previewArea.className = 'upload-preview-area';
    previewArea.id = prevId;

    var fileIcon  = document.createElement('p');
    fileIcon.className = 'upload-file-icon';
    fileIcon.textContent = '📄';

    var previewName = document.createElement('p');
    previewName.className = 'upload-preview-name';
    previewName.id = nameId;

    var previewSize = document.createElement('p');
    previewSize.className = 'upload-preview-size';
    previewSize.id = sizeId;

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'upload-remove-btn';
    removeBtn.dataset.target = inputId;
    removeBtn.dataset.preview = prevId;
    removeBtn.dataset.zone = zoneId;
    removeBtn.textContent = '× Remove';

    previewArea.appendChild(fileIcon);
    previewArea.appendChild(previewName);
    previewArea.appendChild(previewSize);
    previewArea.appendChild(removeBtn);

    zone.appendChild(fileInput);
    zone.appendChild(placeholder);
    zone.appendChild(previewArea);

    var removeRowBtn = document.createElement('button');
    removeRowBtn.type = 'button';
    removeRowBtn.className = 'remove-extra-doc';
    removeRowBtn.dataset.row = rowId;
    removeRowBtn.textContent = 'Remove row';

    row.appendChild(zone);
    row.appendChild(removeRowBtn);

    document.getElementById('extra-docs-list').appendChild(row);

    removeRowBtn.addEventListener('click', function () {
      row.remove();
      extraDocCount = Math.max(0, extraDocCount - 1);
      var addBtn = document.getElementById('add-extra-doc');
      addBtn.disabled = false;
      addBtn.textContent = '+ Add document';
    });

    setupZone(zoneId, inputId, prevId, nameId, sizeId, false);

    if (extraDocCount >= 3) {
      document.getElementById('add-extra-doc').disabled = true;
      document.getElementById('add-extra-doc').textContent = 'Maximum 3 additional documents reached';
    }
  });

  // ── Convert file to base64 ───────────────────────────────────────────────────
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var parts = reader.result.split(',');
        resolve({
          name:     file.name,
          mimeType: file.type,
          ext:      file.name.split('.').pop().toLowerCase(),
          data:     parts[1],
          size:     file.size
        });
      };
      reader.onerror = function () { reject(new Error('Could not read ' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  // ── Collect all text fields ──────────────────────────────────────────────────
  function collectFields() {
    function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
    function radio(name) {
      var el = document.querySelector('input[name="' + name + '"]:checked');
      return el ? el.value : '';
    }
    return {
      formType:              'admission',
      title:                 val('title'),
      firstName:             val('firstName'),
      middleName:            val('middleName'),
      lastName:              val('lastName'),
      dob:                   val('dob'),
      gender:                radio('gender'),
      pronouns:              val('pronouns'),
      niNumber:              val('niNumber'),
      uln:                   val('uln'),
      email:                 val('email'),
      phone:                 val('phone'),
      address1:              val('address1'),
      address2:              val('address2'),
      city:                  val('city'),
      county:                val('county'),
      postcode:              val('postcode').toUpperCase(),
      ethnicity:             val('ethnicity'),
      disability:            val('disability'),
      disabilityType:        val('disabilityType'),
      accessArrangement:     radio('accessArrangement'),
      highestQual:           val('highestQual'),
      englishGrade:          val('englishGrade'),
      mathsGrade:            val('mathsGrade'),
      otherQuals:            val('otherQuals'),
      employmentStatus:      val('employmentStatus'),
      employer:              val('employer'),
      jobTitle:              val('jobTitle'),
      course:                val('course'),
      preferredStart:        val('preferredStart'),
      howHeard:              val('howHeard'),
      additionalInfo:        val('additionalInfo'),
      emergencyName:         val('emergencyName'),
      emergencyRelationship: val('emergencyRelationship'),
      emergencyPhone:        val('emergencyPhone'),
      hp_website:            val('hp_website')
    };
  }

  // ── Client-side validation ───────────────────────────────────────────────────
  function validate(data) {
    var ok = true;
    hideBanner();

    document.querySelectorAll('.field-error').forEach(function (el) {
      el.classList.remove('visible'); el.textContent = '';
    });
    document.querySelectorAll('.form-group.has-error').forEach(function (el) {
      el.classList.remove('has-error');
    });

    function need(id, errId, msg) {
      if (!data[id] || data[id].trim() === '') {
        showErr(errId, msg || 'This field is required.');
        ok = false;
      }
    }

    need('firstName',             'err-firstName',             'First name is required.');
    need('lastName',              'err-lastName',              'Last name is required.');
    need('dob',                   'err-dob',                   'Date of birth is required.');
    need('email',                 'err-email',                 'Email address is required.');
    need('phone',                 'err-phone',                 'Phone number is required.');
    need('address1',              'err-address1',              'Address is required.');
    need('city',                  'err-city',                  'City or town is required.');
    need('postcode',              'err-postcode',              'Postcode is required.');
    need('ethnicity',             'err-ethnicity',             'Please select your ethnic background.');
    need('disability',            'err-disability',            'Please make a disability / LDD declaration.');
    need('highestQual',           'err-highestQual',           'Please select your highest qualification.');
    need('englishGrade',          'err-englishGrade',          'Please select your English grade.');
    need('mathsGrade',            'err-mathsGrade',            'Please select your maths grade.');
    need('employmentStatus',      'err-employmentStatus',      'Please select your employment status.');
    need('course',                'err-course',                'Please select a course.');
    need('preferredStart',        'err-preferredStart',        'Please select a preferred start date.');
    need('emergencyName',         'err-emergencyName',         'Emergency contact name is required.');
    need('emergencyRelationship', 'err-emergencyRelationship', 'Please select the relationship.');
    need('emergencyPhone',        'err-emergencyPhone',        'Emergency contact phone is required.');

    if (!data.gender) {
      showErr('err-gender', 'Please select your gender.');
      ok = false;
    }

    if (data.disability === 'Yes, see below' && !data.disabilityType) {
      showErr('err-disabilityType', 'Please select the type of disability or condition.');
      ok = false;
    }

    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) {
      showErr('err-email', 'Please enter a valid email address.');
      ok = false;
    }

    if (!document.getElementById('photo-input').files[0]) {
      showErr('err-photo', 'A passport-size photo is required.');
      ok = false;
    }

    if (!document.getElementById('id-input').files[0]) {
      showErr('err-id', 'Proof of identity is required.');
      ok = false;
    }

    var decOk = ['dec-accurate', 'dec-data', 'dec-equality', 'dec-ncfe'].every(function (id) {
      return document.getElementById(id).checked;
    });
    if (!decOk) {
      showErr('err-declarations', 'Please read and confirm all four declarations before submitting.');
      ok = false;
    }

    return ok;
  }

  // ── Show/hide loading overlay ────────────────────────────────────────────────
  function showLoading() { document.getElementById('adm-loading').classList.add('visible'); }
  function hideLoading() { document.getElementById('adm-loading').classList.remove('visible'); }

  // ── Form submit ──────────────────────────────────────────────────────────────
  document.getElementById('admission-form').addEventListener('submit', async function (e) {
    e.preventDefault();

    var data = collectFields();
    if (!validate(data)) {
      var firstErr = document.querySelector('.field-error.visible');
      if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showBanner('Please correct the highlighted fields before submitting.');
      return;
    }

    showLoading();
    document.getElementById('adm-submit').disabled = true;

    try {
      var photoFile = document.getElementById('photo-input').files[0];
      var idFile    = document.getElementById('id-input').files[0];
      var qualFile  = document.getElementById('qual-input').files[0];

      var photo = photoFile ? await fileToBase64(photoFile) : null;
      var idDoc = idFile    ? await fileToBase64(idFile)    : null;
      var qual  = qualFile  ? await fileToBase64(qualFile)  : null;

      var extras = [];
      var extraInputs = document.querySelectorAll('.extra-doc-input');
      for (var i = 0; i < extraInputs.length; i++) {
        if (extraInputs[i].files && extraInputs[i].files[0]) {
          extras.push(await fileToBase64(extraInputs[i].files[0]));
        }
      }

      // Total upload size check
      var totalBytes = [photo, idDoc, qual].filter(Boolean).concat(extras)
        .reduce(function (s, f) { return s + (f && f.data ? f.data.length * 0.75 : 0); }, 0);
      if (totalBytes > 40 * 1024 * 1024) {
        hideLoading();
        document.getElementById('adm-submit').disabled = false;
        showBanner('Total upload size is over 40 MB. Please reduce file sizes and try again.');
        return;
      }

      // Submit via hidden iframe + native form POST
      var frameName = 'adm_frame_' + Date.now();
      var iframe = document.createElement('iframe');
      iframe.name = frameName;
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      var form = document.createElement('form');
      form.method  = 'POST';
      form.action  = SCRIPT_URL;
      form.target  = frameName;
      form.enctype = 'application/x-www-form-urlencoded';
      form.style.display = 'none';

      function addField(name, value) {
        var inp = document.createElement('input');
        inp.type  = 'hidden';
        inp.name  = name;
        inp.value = (value == null ? '' : String(value));
        form.appendChild(inp);
      }

      Object.keys(data).forEach(function (k) { addField(k, data[k]); });

      function addFile(prefix, f) {
        if (!f) return;
        addField(prefix + '_data', f.data);
        addField(prefix + '_name', f.name);
        addField(prefix + '_mime', f.mimeType);
        addField(prefix + '_ext',  f.ext);
      }
      addFile('photo', photo);
      addFile('id',    idDoc);
      addFile('qual',  qual);
      extras.forEach(function (f, idx) { addFile('doc' + (idx + 1), f); });

      document.body.appendChild(form);

      var done = false;
      var onLoad = function () {
        if (done) return;
        done = true;
        hideLoading();
        document.getElementById('admission-form').style.display = 'none';
        var success = document.getElementById('adm-success');
        success.classList.add('visible');
        success.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setTimeout(function () {
          try { form.remove(); iframe.remove(); } catch (ex) {}
        }, 1000);
      };
      iframe.addEventListener('load', onLoad);
      setTimeout(onLoad, 30000);

      form.submit();

    } catch (err) {
      hideLoading();
      document.getElementById('adm-submit').disabled = false;
      showBanner(
        'There was a problem submitting your application. ' +
        'Please try again or contact us on +44 207 0990 956 or info@dataaischool.com.'
      );
    }
  });

})();
