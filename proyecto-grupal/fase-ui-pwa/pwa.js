(() => {
  'use strict';
  const main = document.querySelector('main.app-views');
  if (!main) return;

  // Use direct children for compatibility and keep view state explicit.
  const views = Array.from(main.children).filter(element =>
    element.classList && element.classList.contains('app-view')
  );
  if (!views.length) return;

  const findView = hash => {
    const id = String(hash || '').replace(/^#/,'');
    if (!id) return views[0];
    const direct = views.find(view =>
      view.id === id || view.id === 'view-' + id || view.dataset.viewName === id
    );
    if (direct) return direct;
    const target = document.getElementById(id);
    return target ? views.find(view => view.contains(target)) || null : null;
  };

  const showView = target => {
    const view = typeof target === 'string' ? findView(target) : target;
    if (!view || !views.includes(view)) return false;

    views.forEach(item => {
      const active = item === view;
      item.hidden = !active;
      item.classList.toggle('active', active);
      item.setAttribute('aria-hidden', String(!active));
      if ('inert' in item) item.inert = !active;
    });

    const name = view.dataset.viewName || view.id.replace('view-','');
    document.querySelectorAll('.main-nav a,.mobile-nav a').forEach(link => {
      const active = findView(link.getAttribute('href')) === view;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    });

    const firstId = view.id === 'view-inicio'
      ? 'inicio'
      : (view.querySelector('[id]')?.id || name);
    if (location.hash !== '#' + firstId && history.replaceState) {
      history.replaceState(null, '', '#' + firstId);
    }

    window.scrollTo({top:0,behavior:'auto'});
    document.dispatchEvent(new CustomEvent('appviewchange',{detail:{name}}));
    return true;
  };

  document.addEventListener('click', event => {
    const element = event.target instanceof Element ? event.target : event.target.parentElement;
    const link = element && element.closest('a[href^="#"]');
    if (!link) return;
    const view = findView(link.getAttribute('href'));
    if (!view) return;

    event.preventDefault();
    showView(view);

    const menu = document.getElementById('mobileNav');
    const toggle = document.getElementById('menuToggle');
    if (menu && menu.classList.contains('open')) {
      menu.classList.remove('open');
      if (toggle) {
        toggle.setAttribute('aria-expanded','false');
        toggle.setAttribute('aria-label','Abrir menú');
        toggle.textContent = '☰';
      }
    }
  }, true);

  window.addEventListener('hashchange', () => {
    const view = findView(location.hash);
    if (view) showView(view);
  });

  window.appShowView = target => showView(target);
  const initial = findView(location.hash) || views.find(view => view.id === 'view-inicio') || views[0];
  showView(initial);
})();
(() => {
'use strict';

const SUPABASE_URL = 'https://xjikajydwcdicrtcvhmf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_COnaqUWHWC1Q-QfRZ__YSA_wtRCdR3y';
const THEME_KEY = 'pata_andina_theme_v2';
const $ = id => document.getElementById(id);
const qa = (selector, root=document) => Array.from(root.querySelectorAll(selector));
const make = (tag, className, value) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
};

let client = null;
let authMode = 'login';
let servicePage = 1;
let filteredServices = [];
let currentUser = null;
let currentProfile = null;
let currentPets = [];
let services = [];
let pendingBooking = null;
let toastTimer = null;
let menuOpen = false;
let guestNotice = '';
let isStaff = false;
let recoveringPassword = false;

const today = () => {
  const date = new Date();
  return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
};
const money = value => value === null || value === undefined || value === '' ? 'Consultar' : 'Bs ' + Number(value).toLocaleString('es-BO');
const selectedService = () => services.find(item => item.id === $('serviceSelect').value) || null;
const setStatus = (id, message, error=false) => {
  const node = $(id);
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('error', error);
};
const toast = (message, error=false) => {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('error', error);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 4200);
};
function syncStaffNavigation() {
  qa('[data-staff-link]').forEach(link => { link.hidden = !isStaff; });
}

function guardStaffRoute() {
  if (location.hash !== '#admin' || isStaff) return;
  if (window.appShowView) window.appShowView('cuenta');
  setStatus('authStatus',
    currentUser ? 'Esta pantalla es exclusiva del personal autorizado.' : 'Inicia sesión con una cuenta autorizada para acceder al panel.',
    true
  );
}

document.addEventListener('appviewchange', event => {
  if (event.detail && event.detail.name === 'admin' && !isStaff) guardStaffRoute();
});

const safeError = error => {
  const message = String(error && (error.message || error) || '');
  if (/duplicate key|unique constraint/i.test(message)) return 'Ya existe un registro con esos datos.';
  if (/horario solicitado|overlap|exclusion/i.test(message)) return 'Ese horario ya no está disponible. Elige otra hora.';
  if (/row-level security|permission denied|42501/i.test(message)) return 'La cuenta no tiene permiso para realizar esta operación.';
  if (/invalid login credentials/i.test(message)) return 'Correo o contraseña incorrectos.';
  if (/email not confirmed/i.test(message)) return 'Confirma tu correo electrónico antes de iniciar sesión.';
  return message || 'No se pudo completar la operación. Intenta nuevamente.';
};

function initSupabase() {
  if (!window.supabase || typeof window.supabase.createClient !== 'function') return false;
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return true;
}

function bindPhotoFallbacks() {
  const pairs = [['.hero-visual img','./imagenes/portada-veterinaria.svg'],['.food-banner img','./imagenes/gato.svg']];
  pairs.forEach(([selector,fallback]) => {
    const image = document.querySelector(selector);
    if (!image) return;
    const apply = () => {
      if (image.dataset.fallbackApplied === 'true') return;
      image.dataset.fallbackApplied = 'true';
      image.src = fallback;
    };
    image.addEventListener('error', apply, {once:true});
    if (image.complete && image.naturalWidth === 0) apply();
  });
}

function renderServices(items,keepPage=false) {
  const grid = $('serviceGrid');
  if (!grid) return;
  filteredServices = items;
  grid.replaceChildren();
  const pageSize = () => window.innerWidth <= 620 ? 4 : 6;
  const pageCount = Math.max(1,Math.ceil(items.length/pageSize()));
  if (!keepPage) servicePage = 1;
  servicePage = Math.min(Math.max(servicePage,1),pageCount);
  const visible = items.slice((servicePage-1)*pageSize(),servicePage*pageSize());
  if (!visible.length) {
    grid.append(make('p','empty-catalog','No hay servicios que coincidan con la búsqueda.'));
  }
  visible.forEach(service => {
    const card = make('article','service-card');
    const art = make('div','service-card__art');
    const image = make('img','service-card__image');
    image.src = service.image;
    image.alt = service.imageAlt || 'Atención veterinaria';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.width = 480;
    image.height = 280;
    image.fetchPriority = 'low';
    image.addEventListener('error', () => {
      if (image.dataset.fallbackApplied === 'true') return;
      image.dataset.fallbackApplied = 'true';
      image.src = service.fallbackImage || './imagenes/consulta.svg';
    }, {once:true});
    art.append(image, make('span','service-card__tag',service.tag || 'ATENCIÓN'));
    const body = make('div','service-card__body');
    const meta = make('div','service-card__meta');
    meta.append(make('span','',String(service.category || '').toUpperCase()),make('span','',service.durationLabel || (service.duration+' min aprox.')));
    body.append(meta,make('h3','service-card__title',service.name),make('p','service-card__description',service.description));
    const detailButton = make('button','service-card__detail-toggle','Qué incluye +');
    detailButton.type = 'button';
    detailButton.dataset.detailId = service.id;
    detailButton.setAttribute('aria-expanded','false');
    const detail = make('p','service-card__detail',service.details || '');
    detail.id = 'service-detail-' + service.id;
    detail.hidden = true;
    detailButton.setAttribute('aria-controls',detail.id);
    body.append(detailButton,detail);
    const bottom = make('div','service-card__footer');
    const price = make('strong','service-card__price',service.priceLabel || money(service.priceValue));
    const button = make('button','service-card__action','Solicitar ↗');
    button.type = 'button';
    button.dataset.bookService = service.id;
    bottom.append(price,button);
    body.append(bottom);
    card.append(art,body);
    grid.append(card);
  });
  const pager = $('servicePager');
  pager.replaceChildren();
  if (items.length > pageSize()) {
    const previous = make('button','pager-button','← Anterior');
    previous.type = 'button';
    previous.dataset.page = 'prev';
    previous.disabled = servicePage === 1;
    const label = make('span','', 'Página ' + servicePage + ' de ' + pageCount);
    const next = make('button','pager-button','Siguiente →');
    next.type = 'button';
    next.dataset.page = 'next';
    next.disabled = servicePage === pageCount;
    pager.append(previous,label,next);
    pager.hidden = false;
  } else {
    pager.hidden = true;
  }
}
function mapService(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    details: row.details,
    duration: Number(row.duration_minutes) || 30,
    durationLabel: (Number(row.duration_minutes) || 30) + ' min aprox.',
    priceValue: row.price_value === null ? null : Number(row.price_value),
    priceLabel: row.price_label || money(row.price_value),
    tag: row.tag || '',
    image: row.image,
    species: row.species,
    imageAlt: row.image_alt,
    fallbackImage: row.fallback_image
  };
}

async function loadServices() {
  try {
    const result = await client.from('services_catalog')
      .select('id,name,category,description,details,duration_minutes,price_value,price_label,tag,image,species,image_alt,fallback_image')
      .eq('active',true)
      .order('display_order');
    if (result.error) throw result.error;
    services = (result.data || []).map(mapService);
    if (!services.length) throw new Error('El catálogo no tiene servicios activos.');
    renderServices(services);
  } catch (error) {
    try {
      const response = await fetch('./data/servicios.json');
      if (!response.ok) throw new Error('No se pudo cargar el catálogo local.');
      services = (await response.json()).filter(item => item && item.id && item.name);
      renderServices(services);
      $('catalogStatus').textContent = 'Catálogo local disponible; revisa tu conexión para actualizarlo.';
    } catch (_) {
      $('serviceGrid').replaceChildren(make('p','empty-catalog','No se pudo cargar el catálogo. Revisa tu conexión e inténtalo de nuevo.'));
      setStatus('catalogStatus',safeError(error),true);
    }
  }
  fillServiceSelect();
  updateBookingSummary();
}

function fillServiceSelect() {
  const select = $('serviceSelect');
  if (!select) return;
  const oldValue = select.value;
  select.replaceChildren(new Option('Selecciona un servicio',''));
  services.forEach(item => select.add(new Option(item.name + ' · ' + (item.priceLabel || money(item.priceValue)),item.id)));
  if (services.some(item => item.id === oldValue)) select.value = oldValue;
}

function renderFoods(items) {
  const grid = $('catFoodGrid');
  if (!grid) return;
  grid.replaceChildren();
  items.forEach(item => {
    const card = make('article','food-card');
    const art = make('div','food-card__art');
    const image = make('img','food-card__image');
    image.src = item.image;
    image.alt = item.imageAlt || item.name;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.width = 480;
    image.height = 320;
    image.fetchPriority = 'low';
    image.addEventListener('error',() => {
      if (image.dataset.fallbackApplied === 'true') return;
      image.dataset.fallbackApplied = 'true';
      image.src = './imagenes/gato.svg';
    },{once:true});
    art.append(image);
    const body = make('div','food-card__body');
    body.append(make('span','food-card__kind',item.kind),make('h3','food-card__title',item.name),make('p','food-card__description',item.description),make('small','food-card__presentation',item.presentation),make('small','food-card__guidance',item.guidance || 'Consulta antes de cambiar la dieta.'));
    card.append(art,body);
    grid.append(card);
  });
  $('foodCatalogStatus').textContent = items.length + ' referencias de alimentación.';
}

async function loadFoods() {
  try {
    const response = await fetch('./data/productos-gatos.json');
    if (!response.ok) throw new Error('No se pudo cargar el catálogo.');
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error('Catálogo no válido.');
    renderFoods(items);
  } catch (_) {
    $('catFoodGrid').replaceChildren(make('p','empty-catalog','No se pudo cargar la información de alimentación.'));
  }
}

function updateBookingSummary() {
  const service = selectedService();
  $('summaryPet').textContent = $('petName').value.trim() || 'Tu mascota';
  $('summarySpecies').textContent = $('petSpecies').value || 'Especie por seleccionar';
  $('summaryService').textContent = service ? service.name : 'Elige una opción';
  $('summaryDuration').textContent = service ? service.durationLabel : '—';
  $('summaryPrice').textContent = service ? (service.priceLabel || money(service.priceValue)) : 'Consultar';
  const date = $('bookingDate').value;
  const time = $('bookingTime').value;
  $('summaryDate').textContent = date && time ? date.split('-').reverse().join('/') + ' · ' + time : 'Por definir';
}

function validateBooking() {
  const name = $('ownerName').value.trim();
  const phone = $('ownerPhone').value.replace(/\D/g,'');
  const email = $('ownerEmail').value.trim();
  const pet = $('petName').value.trim();
  const species = $('petSpecies').value;
  const service = selectedService();
  const date = $('bookingDate').value;
  const time = $('bookingTime').value;
  const consent = $('bookingConsent').checked;
  const validName = name.length >= 2 && name.length <= 90;
  const validPhone = /^\d{8}$/.test(phone);
  const validEmail = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const validPet = pet.length >= 1 && pet.length <= 60;
  const validSpecies = ['Perro','Gato','Otra especie'].includes(species);
  const validService = !!service;
  const validDate = !!date && date >= today();
  const validTime = !!time && (date !== today() || new Date(date + 'T' + time + ':00').getTime() > Date.now());
  const validConsent = consent;
  setStatus('ownerNameError',validName?'':'Escribe tu nombre completo.',!validName);
  setStatus('ownerPhoneError',validPhone?'':'Ingresa un celular boliviano de 8 dígitos.',!validPhone);
  setStatus('ownerEmailError',validEmail?'':'Revisa el correo electrónico.',!validEmail);
  setStatus('petNameError',validPet?'':'Escribe el nombre de tu mascota.',!validPet);
  setStatus('speciesError',validSpecies?'':'Selecciona la especie.',!validSpecies);
  setStatus('serviceError',validService?'':'Selecciona un servicio.',!validService);
  setStatus('dateError',validDate?'':'Selecciona hoy o una fecha futura.',!validDate);
  setStatus('timeError',validTime?'':'Selecciona una hora disponible.',!validTime);
  setStatus('consentError',validConsent?'':'Confirma que los datos son correctos.',!validConsent);
  return validName && validPhone && validEmail && validPet && validSpecies && validService && validDate && validTime && validConsent;
}

function openBookingModal(data) {
  pendingBooking = data;
  const box = $('modalSummary');
  box.replaceChildren();
  [['Tutor',data.ownerName],['Mascota',data.petName + ' · ' + data.species],['Servicio',data.serviceName],['Fecha',data.date.split('-').reverse().join('/') + ' · ' + data.time],['Precio',data.priceLabel]].forEach(([label,value]) => {
    const row = make('div','modal-line');
    row.append(make('span','',label),make('b','',value));
    box.append(row);
  });
  $('bookingModal').classList.add('open');
  $('bookingModal').setAttribute('aria-hidden','false');
  $('confirmBooking').disabled = false;
  $('confirmBooking').textContent = 'Enviar solicitud';
  $('confirmBooking').focus();
}

function closeBookingModal() {
  $('bookingModal').classList.remove('open');
  $('bookingModal').setAttribute('aria-hidden','true');
  pendingBooking = null;
}

async function ensurePetForUser(data) {
  if (!currentUser) return null;
  const existing = currentPets.find(item => item.owner_id === currentUser.id && item.name.toLocaleLowerCase('es-BO') === data.petName.toLocaleLowerCase('es-BO') && item.species === data.species);
  if (existing) return existing.id;
  const response = await client.from('pets').insert({
    owner_id: currentUser.id,
    name: data.petName,
    species: data.species,
    age_text: data.petAge || null
  }).select('id,name,species,age_text').single();
  if (response.error) throw response.error;
  currentPets.unshift(response.data);
  renderPets();
  return response.data.id;
}

async function confirmBooking() {
  if (!pendingBooking) return;
  if (!client) {
    toast('No se pudo conectar con la base de datos. Revisa tu conexión e inténtalo de nuevo.',true);
    return;
  }
  const button = $('confirmBooking');
  button.disabled = true;
  button.textContent = 'Enviando...';
  try {
    const data = pendingBooking;
    let petId = null;
    if (currentUser) petId = await ensurePetForUser(data);
    const payload = {
      owner_id: currentUser ? currentUser.id : null,
      pet_id: petId,
      owner_name: data.ownerName,
      owner_phone: data.ownerPhone,
      owner_email: data.ownerEmail || null,
      pet_name: data.petName,
      species: data.species,
      pet_age: data.petAge || null,
      service_id: data.serviceId,
      service_name: data.serviceName,
      price_label: data.priceLabel,
      duration_minutes: data.duration,
      requested_date: data.date,
      requested_time: data.time,
      notes: data.note || null,
      status: 'requested'
    };
    const result = await client.from('appointment_requests').insert(payload);
    if (result.error) throw result.error;
    guestNotice = 'Solicitud enviada correctamente. El horario está pendiente de confirmación.';
    closeBookingModal();
    $('bookingForm').reset();
    $('bookingDate').min = today();
    $('bookingDate').value = today();
    updateBookingSummary();
    if (currentUser) await loadAccountData();
    renderAppointments();
    toast('Solicitud registrada. El centro debe confirmar el turno.');
    if (window.appShowView) window.appShowView('turnos');
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Enviar solicitud';
    toast(safeError(error),true);
  }
}

function renderAppointments() {
  const list = $('appointmentList');
  const notice = $('guestBookingNotice');
  list.replaceChildren();
  if (!currentUser) {
    list.append(make('p','empty-appointments','Inicia sesión para consultar tus solicitudes. Las solicitudes enviadas sin cuenta quedan registradas para que la clínica las revise.'));
    $('appointmentCount').textContent = 'CUENTA';
  } else {
    loadAppointmentsInto(list,'appointmentCount');
  }
  if (notice) notice.textContent = guestNotice;
}

function statusName(status) {
  const labels = {requested:'Pendiente',confirmed:'Confirmado',cancelled:'Cancelado',completed:'Atendido',rejected:'No aceptado'};
  return labels[status] || status;
}

async function loadAppointmentsInto(target,countId) {
  if (!currentUser) return;
  target.replaceChildren(make('p','loading-card','Cargando solicitudes...'));
  const result = await client.from('appointment_requests')
    .select('id,pet_name,species,service_name,requested_date,requested_time,price_label,status,created_at')
    .eq('owner_id',currentUser.id)
    .order('created_at',{ascending:false});
  target.replaceChildren();
  if (result.error) {
    target.append(make('p','empty-appointments',safeError(result.error)));
    if (countId) $(countId).textContent = 'ERROR';
    return;
  }
  const items = result.data || [];
  if (countId) $(countId).textContent = items.length + (items.length===1?' SOLICITUD':' SOLICITUDES');
  if (!items.length) {
    target.append(make('p','empty-appointments','Todavía no tienes solicitudes registradas.'));
    return;
  }
  items.forEach(item => {
    const row = make('article','appointment-item');
    const info = make('div','appointment-info');
    const date = String(item.requested_date).split('-').reverse().join('/');
    info.append(make('b','',item.pet_name + ' · ' + item.service_name),make('p','',item.species + ' · ' + date + ' a las ' + String(item.requested_time).slice(0,5) + ' · ' + item.price_label));
    const actions = make('div','appointment-actions');
    actions.append(make('span','appointment-state',statusName(item.status)));
    if (item.status === 'requested') {
      const cancel = make('button','cancel-button','Cancelar solicitud');
      cancel.type = 'button';
      cancel.dataset.cancelAppointment = item.id;
      actions.append(cancel);
    }
    row.append(info,actions);
    target.append(row);
  });
}

async function cancelAppointment(id) {
  const result = await client.from('appointment_requests').update({status:'cancelled'}).eq('id',id).eq('status','requested');
  if (result.error) {
    toast(safeError(result.error),true);
    return;
  }
  await loadAccountData();
  toast('Solicitud cancelada.');
}

function renderPets() {
  const list = $('petList');
  if (!list) return;
  list.replaceChildren();
  if (!currentPets.length) {
    list.append(make('p','empty-appointments','Aún no has registrado mascotas.'));
  } else {
    currentPets.forEach(pet => {
      const card = make('article','pet-row');
      const info = make('div','pet-info');
      info.append(make('b','',pet.name),make('p','',[pet.species,pet.age_text,pet.breed].filter(Boolean).join(' · ')));
      card.append(info);
      if (!isStaff) {
        const details = document.createElement('details');
        details.className = 'pet-editor';
        const summary = make('summary','','Editar datos');
        const form = make('form','pet-edit-form');
        form.dataset.editPet = pet.id;
        const nameLabel = make('label','pet-edit-field','Nombre');
        const nameInput = document.createElement('input');
        nameInput.name = 'name';
        nameInput.maxLength = 60;
        nameInput.required = true;
        nameInput.value = pet.name;
        nameLabel.append(nameInput);
        const speciesLabel = make('label','pet-edit-field','Especie');
        const speciesSelect = document.createElement('select');
        speciesSelect.name = 'species';
        ['Perro','Gato','Otra especie'].forEach(value=>speciesSelect.add(new Option(value,value)));
        speciesSelect.value = pet.species;
        speciesLabel.append(speciesSelect);
        const ageLabel = make('label','pet-edit-field','Edad');
        const ageInput = document.createElement('input');
        ageInput.name = 'age_text';
        ageInput.maxLength = 40;
        ageInput.value = pet.age_text || '';
        ageLabel.append(ageInput);
        const breedLabel = make('label','pet-edit-field','Raza');
        const breedInput = document.createElement('input');
        breedInput.name = 'breed';
        breedInput.maxLength = 80;
        breedInput.value = pet.breed || '';
        breedLabel.append(breedInput);
        const save = make('button','button button-outline','Guardar cambios');
        save.type = 'submit';
        form.append(nameLabel,speciesLabel,ageLabel,breedLabel,save);
        details.append(summary,form);
        card.append(details);
      } else {
        card.append(make('span','appointment-state','Registrada'));
      }
      list.append(card);
    });
  }
  const select = $('recordPet');
  if (select) {
    const old = select.value;
    select.replaceChildren(new Option('Selecciona una mascota',''));
    currentPets.forEach(pet => select.add(new Option(pet.name + ' · ' + pet.species,pet.id)));
    if (currentPets.some(pet=>pet.id===old)) select.value = old;
  }
}

async function loadAccountData() {
  if (!currentUser) return;
  $('authPanel').hidden = true;
  $('accountDashboard').hidden = false;
  $('accountGreeting').textContent = 'Hola, ' + ((currentProfile && currentProfile.full_name) || currentUser.email);
  $('accountEmailText').textContent = currentUser.email || '';
  isStaff = !!(currentUser.app_metadata && currentUser.app_metadata.role === 'staff');
  syncStaffNavigation();
  let petsQuery = client.from('pets').select('id,owner_id,name,species,breed,age_text,weight_kg,notes,created_at').order('created_at',{ascending:false});
  if (!isStaff) petsQuery = petsQuery.eq('owner_id',currentUser.id);
  const [profileResult,petsResult] = await Promise.all([
    client.from('profiles').select('id,full_name,phone').eq('id',currentUser.id).maybeSingle(),
    petsQuery
  ]);
  if (profileResult.error) setStatus('profileStatus',safeError(profileResult.error),true);
  else {
    currentProfile = profileResult.data || {id:currentUser.id,full_name:'',phone:''};
    $('profileName').value = currentProfile.full_name || '';
    $('profilePhone').value = currentProfile.phone || '';
    $('accountGreeting').textContent = 'Hola, ' + (currentProfile.full_name || currentUser.email);
    if (!$('ownerName').value.trim()) $('ownerName').value = currentProfile.full_name || '';
    if (!$('ownerPhone').value.trim()) $('ownerPhone').value = currentProfile.phone || '';
    if (!$('ownerEmail').value.trim()) $('ownerEmail').value = currentUser.email || '';
  }
  if (petsResult.error) {
    $('petList').replaceChildren(make('p','empty-appointments',safeError(petsResult.error)));
    currentPets = [];
  } else currentPets = petsResult.data || [];
  renderPets();
  const petHeading = document.querySelector('#accountDashboard .account-columns section:first-child h3');
  if (petHeading) petHeading.textContent = isStaff ? 'Mascotas registradas' : 'Mis mascotas';
  await loadAppointmentsInto($('accountAppointments'),null);
  await loadMedicalRecords();
  $('staffPanel').hidden = !isStaff;
  $('staffActivationForm').hidden = isStaff;
  if (isStaff) {
    await loadStaffData();
    await loadClinicActivity();
  }
}

async function loadMedicalRecords() {
  const list = $('medicalRecordList');
  list.replaceChildren(make('p','loading-card','Cargando historial...'));
  const ids = currentPets.map(pet=>pet.id);
  if (!ids.length) {
    list.replaceChildren(make('p','empty-appointments','Registra una mascota para consultar su historial.'));
    return;
  }
  const result = await client.from('pet_medical_records')
    .select('id,pet_id,record_date,record_type,summary,diagnosis,treatment,prescriptions,next_visit_date')
    .in('pet_id',ids)
    .order('record_date',{ascending:false});
  list.replaceChildren();
  if (result.error) {
    list.append(make('p','empty-appointments',safeError(result.error)));
    return;
  }
  if (!(result.data || []).length) {
    list.append(make('p','empty-appointments','La clínica aún no ha registrado atenciones para tus mascotas.'));
    return;
  }
  result.data.forEach(record => {
    const pet = currentPets.find(item=>item.id===record.pet_id);
    const article = make('article','record-row');
    article.append(make('span','record-date',String(record.record_date).split('-').reverse().join('/')),make('h4','',(pet?pet.name:'Mascota')+' · '+record.record_type),make('p','',record.summary));
    if (record.diagnosis) article.append(make('p','', 'Diagnóstico: '+record.diagnosis));
    if (record.treatment) article.append(make('p','', 'Tratamiento: '+record.treatment));
    if (record.prescriptions) article.append(make('p','', 'Indicaciones: '+record.prescriptions));
    if (record.next_visit_date) article.append(make('small','', 'Próximo control: '+String(record.next_visit_date).split('-').reverse().join('/')));
    list.append(article);
  });
}

async function loadClinicActivity() {
  if (!isStaff) return;
  const list = $('clinicActivityLog');
  if (!list) return;
  list.replaceChildren(make('p','loading-card','Cargando actividad...'));
  const result = await client.from('clinic_activity_log')
    .select('id,event_type,event_summary,details,created_at')
    .order('created_at',{ascending:false})
    .limit(12);
  list.replaceChildren();
  if (result.error) {
    list.append(make('p','empty-appointments',safeError(result.error)));
    return;
  }
  const items = result.data || [];
  if (!items.length) {
    list.append(make('p','empty-appointments','Todavía no hay movimientos registrados.'));
    return;
  }
  const labels = {
    tutor_profile_created:'Nuevo tutor',
    pet_registered:'Mascota registrada',
    appointment_requested:'Solicitud de turno',
    appointment_status_changed:'Cambio de estado',
    medical_record_added:'Atención médica'
  };
  items.forEach(item => {
    const entry = make('article','clinic-activity-item');
    const heading = make('div','clinic-activity-heading');
    heading.append(make('b','',labels[item.event_type] || 'Actividad de la clínica'));
    const timestamp = new Date(item.created_at);
    const dateText = Number.isNaN(timestamp.getTime()) ? 'Fecha no disponible' : timestamp.toLocaleString('es-BO',{
      dateStyle:'short',
      timeStyle:'short',
      timeZone:'America/La_Paz'
    });
    heading.append(make('time','',dateText));
    entry.append(heading,make('p','',item.event_summary));
    if (item.event_type === 'appointment_status_changed' && item.details) {
      const from = statusName(item.details.from || '');
      const to = statusName(item.details.to || '');
      if (from && to) entry.append(make('small','clinic-activity-detail',from + ' → ' + to));
    }
    list.append(entry);
  });
}

async function downloadClinicBackup() {
  if (!isStaff) return;
  if (!window.confirm('El respaldo contiene datos personales e historiales de la clínica. Guárdalo en un lugar privado. ¿Descargar ahora?')) return;
  const button = $('downloadClinicBackup');
  button.disabled = true;
  setStatus('backupStatus','Preparando respaldo...');
  try {
    const result = await client.functions.invoke('clinic-backup',{body:{action:'export'}});
    if (result.error) throw result.error;
    const backup = result.data;
    if (!backup || backup.format !== 'pata-andina-backup' || backup.version !== 1 || !backup.watermark || !Array.isArray(backup.control_array)) {
      throw new Error('El servidor devolvió un archivo de respaldo no válido.');
    }
    const blob = new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    link.href = url;
    link.download = 'pata-andina-respaldo-' + stamp + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
    setStatus('Respaldo descargado. Guárdalo en un lugar seguro.');
  } catch (error) {
    setStatus('No se pudo generar el respaldo: ' + safeError(error),true);
  } finally {
    button.disabled = false;
  }
}

async function restoreClinicBackup(event) {
  if (!isStaff) return;
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = '';
  if (file.size > 5 * 1024 * 1024) {
    setStatus('El archivo supera el límite de 5 MB.',true);
    return;
  }
  try {
    const backup = JSON.parse(await file.text());
    if (!backup || backup.format !== 'pata-andina-backup' || backup.version !== 1 || !backup.tables || typeof backup.tables !== 'object') {
      throw new Error('El archivo no corresponde a un respaldo de Pata Andina.');
    }
    if (!window.confirm('La restauración solo agrega registros que no existan. No elimina ni sobrescribe los datos actuales. ¿Deseas continuar?')) return;
    setStatus('Validando integridad y restaurando datos...');
    const result = await client.functions.invoke('clinic-backup',{body:{action:'restore',backup}});
    if (result.error) throw result.error;
    const counts = result.data && result.data.result && result.data.result.restored;
    if (!counts) throw new Error('El servidor no devolvió el resumen de restauración.');
    await loadAccountData();
    const total = Object.values(counts).reduce((sum,value)=>sum + Number(value || 0),0);
    setStatus('Restauración finalizada. Se agregaron ' + total + ' registros que faltaban. Los existentes se conservaron.');
  } catch (error) {
    setStatus('No se pudo restaurar el archivo: ' + safeError(error),true);
  }
}

async function loadStaffData() {
  const panel = $('staffAppointments');
  panel.replaceChildren(make('p','loading-card','Cargando agenda...'));
  const result = await client.from('appointment_requests')
    .select('id,owner_name,owner_phone,owner_email,pet_name,species,service_name,requested_date,requested_time,notes,status')
    .order('requested_date',{ascending:true})
    .order('requested_time',{ascending:true});
  panel.replaceChildren();
  if (result.error) {
    panel.append(make('p','empty-appointments',safeError(result.error)));
    return;
  }
  const records = result.data || [];
  if (!records.length) panel.append(make('p','empty-appointments','No hay solicitudes registradas.'));
  records.forEach(item => {
    const card = make('article','staff-appointment');
    const info = make('div','appointment-info');
    const date = String(item.requested_date).split('-').reverse().join('/');
    info.append(make('b','',item.pet_name+' · '+item.service_name),make('p','',item.owner_name+' · '+item.owner_phone+' · '+item.species+' · '+date+' '+String(item.requested_time).slice(0,5)));
    if (item.owner_email) info.append(make('p','',item.owner_email));
    if (item.notes) info.append(make('p','',item.notes));
    const actions = make('div','staff-actions');
    actions.append(make('span','appointment-state',statusName(item.status)));
    if (item.status === 'requested') {
      [['confirmed','Confirmar'],['rejected','Rechazar']].forEach(([status,label])=>{
        const button = make('button','button button-outline',label);
        button.type = 'button';
        button.dataset.staffStatus = status;
        button.dataset.appointmentId = item.id;
        actions.append(button);
      });
    } else if (item.status === 'confirmed') {
      const completed = make('button','button button-outline','Marcar atendida');
      completed.type = 'button';
      completed.dataset.staffStatus = 'completed';
      completed.dataset.appointmentId = item.id;
      actions.append(completed);
    }
    card.append(info,actions);
    panel.append(card);
  });
}

async function saveProfile(event) {
  event.preventDefault();
  const fullName = $('profileName').value.trim();
  const phone = $('profilePhone').value.replace(/\D/g,'');
  if (fullName.length < 2) return setStatus('profileStatus','Escribe tu nombre completo.',true);
  if (phone && !/^\d{8}$/.test(phone)) return setStatus('profileStatus','El celular debe tener 8 dígitos.',true);
  const result = await client.from('profiles').upsert({id:currentUser.id,full_name:fullName,phone:phone||null},{onConflict:'id'});
  if (result.error) return setStatus('profileStatus',safeError(result.error),true);
  currentProfile = {id:currentUser.id,full_name:fullName,phone:phone||null};
  $('accountGreeting').textContent = 'Hola, ' + fullName;
  setStatus('profileStatus','Datos guardados.');
}

async function savePet(event) {
  event.preventDefault();
  const name = $('newPetName').value.trim();
  const species = $('newPetSpecies').value;
  if (!name || !species) return setStatus('petStatus','Completa el nombre y la especie.',true);
  const result = await client.from('pets').insert({
    owner_id:currentUser.id,
    name,
    species,
    age_text:$('newPetAge').value.trim()||null,
    breed:$('newPetBreed').value.trim()||null
  }).select('id,name,species,age_text,breed').single();
  if (result.error) return setStatus('petStatus',safeError(result.error),true);
  currentPets.unshift(result.data);
  $('petForm').reset();
  renderPets();
  setStatus('petStatus','Mascota registrada.');
}


async function updatePetDetails(event) {
  const form = event.target.closest('form[data-edit-pet]');
  if (!form || isStaff) return;
  event.preventDefault();
  const fields = form.elements;
  const name = fields.namedItem('name').value.trim();
  const species = fields.namedItem('species').value;
  const age = fields.namedItem('age_text').value.trim();
  const breed = fields.namedItem('breed').value.trim();
  if (!name || !['Perro','Gato','Otra especie'].includes(species)) {
    toast('Revisa el nombre y la especie.',true);
    return;
  }
  const save = form.querySelector('button[type="submit"]');
  save.disabled = true;
  const result = await client.from('pets')
    .update({name,species,age_text:age||null,breed:breed||null})
    .eq('id',form.dataset.editPet)
    .eq('owner_id',currentUser.id)
    .select('id,owner_id,name,species,age_text,breed')
    .single();
  save.disabled = false;
  if (result.error) {
    toast(safeError(result.error),true);
    return;
  }
  currentPets = currentPets.map(pet=>pet.id===result.data.id?result.data:pet);
  renderPets();
  await loadMedicalRecords();
  toast('Datos de la mascota actualizados.');
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  const recovery = mode === 'recovery';
  $('authSwitch').hidden = recovery;
  $('loginMode').classList.toggle('active',mode === 'login');
  $('signupMode').classList.toggle('active',signup);
  $('accountNameWrap').hidden = !signup;
  $('accountPhoneWrap').hidden = !signup;
  $('accountPassword').autocomplete = signup || recovery ? 'new-password' : 'current-password';
  $('accountPassword').placeholder = recovery ? 'Escribe tu nueva contraseña' : 'Mínimo 8 caracteres';
  $('accountEmail').required = !recovery;
  $('accountEmail').placeholder = recovery ? 'No es necesario para este paso' : 'tucorreo@ejemplo.com';
  $('authSubmit').textContent = recovery ? 'Guardar nueva contraseña' : signup ? 'Crear cuenta' : 'Iniciar sesión';
  $('forgotPassword').hidden = signup || recovery;
  setStatus('authStatus','');
}

async function handleAuth(event) {
  event.preventDefault();
  if (!client) return setStatus('authStatus','No se pudo cargar el servicio de cuentas. Revisa tu conexión.',true);
  const email = $('accountEmail').value.trim().toLowerCase();
  const password = $('accountPassword').value;
  if (authMode !== 'recovery' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setStatus('authStatus','Ingresa un correo válido.',true);
  if (password.length < 8) return setStatus('authStatus','La contraseña debe tener al menos 8 caracteres.',true);
  $('authSubmit').disabled = true;
  setStatus('authStatus',authMode==='signup'?'Creando cuenta...':'Ingresando...');
  try {
    if (authMode === 'recovery') {
      const result = await client.auth.updateUser({password});
      if (result.error) throw result.error;
      await client.auth.signOut();
      setAuthMode('login');
      $('accountPassword').value = '';
      setStatus('authStatus','Contraseña actualizada. Ya puedes iniciar sesión con tu nueva contraseña.');
      toast('Contraseña actualizada.');
    } else if (authMode === 'signup') {
      const fullName = $('accountName').value.trim();
      const phone = $('accountPhone').value.replace(/\D/g,'');
      if (fullName.length < 2) throw new Error('Escribe tu nombre completo.');
      if (phone && !/^\d{8}$/.test(phone)) throw new Error('El celular debe tener 8 dígitos.');
      const result = await client.auth.signUp({
        email,
        password,
        options: {
          data: {full_name:fullName,phone:phone||null}
        }
      });
      if (result.error) throw result.error;
      if (result.data.session) {
        currentUser = result.data.user;
        currentProfile = {id:currentUser.id,full_name:fullName,phone:phone||null};
        const saved = await client.from('profiles').upsert({id:currentUser.id,full_name:fullName,phone:phone||null},{onConflict:'id'});
        if (saved.error) throw saved.error;
        await showSignedIn();
        toast('Cuenta creada.');
      } else {
        setStatus('authStatus','La cuenta quedó pendiente de confirmación. Para habilitar el acceso directo temporal, desactiva “Confirm email” en Authentication → Providers → Email en Supabase.');
      }
    } else {
      const result = await client.auth.signInWithPassword({email,password});
      if (result.error) throw result.error;
      currentUser = result.data.user;
      await showSignedIn();
      toast('Sesión iniciada.');
    }
  } catch (error) {
    setStatus('authStatus',safeError(error),true);
  } finally {
    $('authSubmit').disabled = false;
  }
}

async function showSignedIn() {
  const result = await client.auth.getUser();
  if (result.error) throw result.error;
  currentUser = result.data.user;
  $('authPanel').hidden = true;
  $('accountDashboard').hidden = false;
  await loadAccountData();
  renderAppointments();
}

async function handleSignOut() {
  const result = await client.auth.signOut();
  if (result.error) return toast(safeError(result.error),true);
  currentUser = null;
  currentProfile = null;
  currentPets = [];
  isStaff = false;
  syncStaffNavigation();
  guardStaffRoute();
  $('accountDashboard').hidden = true;
  $('authPanel').hidden = false;
  setAuthMode('login');
  renderAppointments();
  toast('Sesión cerrada.');
}

async function resetPassword() {
  const email = $('accountEmail').value.trim().toLowerCase();
  if (!email) return setStatus('authStatus','Escribe tu correo para recuperar la contraseña.',true);
  const result = await client.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin+window.location.pathname});
  if (result.error) return setStatus('authStatus',safeError(result.error),true);
  setStatus('authStatus','Si el correo está registrado, recibirás un enlace para restablecer tu contraseña.');
}

async function activateClinicStaff(event) {
  event.preventDefault();
  const code = $('staffActivationCode').value.trim();
  if (code.length < 32) return setStatus('staffActivationStatus','Ingresa el código completo.',true);
  $('staffActivationSubmit').disabled = true;
  setStatus('staffActivationStatus','Validando código...');
  try {
    const result = await client.rpc('activate_clinic_staff',{activation_code:code});
    if (result.error) throw result.error;
    const refreshed = await client.auth.refreshSession();
    if (refreshed.error) throw refreshed.error;
    currentUser = refreshed.data.user;
    $('staffActivationCode').value = '';
    await loadAccountData();
    toast('Acceso de personal activado.');
    if (window.appShowView) window.appShowView('admin');
  } catch (error) {
    setStatus('staffActivationStatus',safeError(error),true);
  } finally {
    $('staffActivationSubmit').disabled = false;
  }
}

async function staffUpdateStatus(id,status) {
  const result = await client.from('appointment_requests').update({status}).eq('id',id);
  if (result.error) return toast(safeError(result.error),true);
  await Promise.all([loadStaffData(),loadClinicActivity()]);
  toast('Estado actualizado.');
}

async function saveMedicalRecord(event) {
  event.preventDefault();
  if (!isStaff) return;
  const petId = $('recordPet').value;
  const summary = $('recordSummary').value.trim();
  if (!petId || summary.length < 2) return setStatus('recordStatus','Selecciona una mascota y escribe el resumen.',true);
  const result = await client.from('pet_medical_records').insert({
    pet_id:petId,
    recorded_by:currentUser.id,
    record_type:$('recordType').value.trim()||'Consulta',
    summary,
    diagnosis:$('recordDiagnosis').value.trim()||null,
    treatment:$('recordTreatment').value.trim()||null,
    prescriptions:$('recordPrescriptions').value.trim()||null,
    next_visit_date:$('recordNextVisit').value||null
  });
  if (result.error) return setStatus('recordStatus',safeError(result.error),true);
  $('medicalRecordForm').reset();
  $('recordType').value = 'Consulta';
  await loadMedicalRecords();
  await loadClinicActivity();
  setStatus('recordStatus','Atención registrada en el historial.');
}

function renderAppointmentCountGuest() {
  if (!currentUser) $('appointmentCount').textContent = 'INICIA SESIÓN';
}

function applyServiceFilters(activeButton=null) {
  const selected = activeButton || qa('[data-filter].active')[0] || qa('[data-filter]')[0];
  const category = selected ? selected.dataset.filter : 'todos';
  qa('[data-filter]').forEach(item => {
    const active = item === selected;
    item.classList.toggle('active',active);
    item.setAttribute('aria-pressed',String(active));
  });
  const term = $('serviceSearch').value.trim().toLocaleLowerCase('es-BO');
  const filtered = services.filter(item =>
    (category === 'todos' || item.category === category) &&
    (item.name+' '+item.description+' '+item.category+' '+item.species).toLocaleLowerCase('es-BO').includes(term)
  );
  renderServices(filtered);
}

function bindEvents() {
  document.addEventListener('submit',updatePetDetails);
  document.addEventListener('click',event=>{
    const link = event.target.closest('a[href^="#"]');
    if (link && link.closest('.mobile-nav')) closeMenu();
    const filter = event.target.closest('[data-filter]');
    if (filter) { applyServiceFilters(filter); return; }
    const page = event.target.closest('#servicePager [data-page]');
    if (page) {
      servicePage += page.dataset.page === 'next' ? 1 : -1;
      renderServices(filteredServices,true);
      return;
    }
    const detail = event.target.closest('[data-detail-id]');
    if (detail) {
      const panel = detail.nextElementSibling;
      const open = detail.getAttribute('aria-expanded') !== 'true';
      detail.setAttribute('aria-expanded',String(open));
      detail.textContent = open ? 'Ocultar detalles −' : 'Qué incluye +';
      panel.hidden = !open;
      return;
    }
    const book = event.target.closest('[data-book-service]');
    if (book) {
      $('serviceSelect').value = book.dataset.bookService;
      updateBookingSummary();
      if (window.appShowView) window.appShowView('reservar');
      $('ownerName').focus({preventScroll:true});
      return;
    }
    const cancel = event.target.closest('[data-cancel-appointment]');
    if (cancel) {
      cancelAppointment(cancel.dataset.cancelAppointment);
      return;
    }
    const staff = event.target.closest('[data-staff-status]');
    if (staff) {
      staffUpdateStatus(staff.dataset.appointmentId,staff.dataset.staffStatus);
      return;
    }
  });

  const serviceLayout = window.matchMedia('(max-width: 620px)');
  const refreshServiceLayout = () => { if (services.length) renderServices(filteredServices,true); };
  if (serviceLayout.addEventListener) serviceLayout.addEventListener('change',refreshServiceLayout);
  else if (serviceLayout.addListener) serviceLayout.addListener(refreshServiceLayout);
  $('serviceSearch').addEventListener('input',()=>applyServiceFilters());
  ['petName','petSpecies','serviceSelect','bookingDate','bookingTime'].forEach(id=>$(id).addEventListener('change',updateBookingSummary));
  $('petName').addEventListener('input',updateBookingSummary);
  $('ownerPhone').addEventListener('input',event=>event.target.value=event.target.value.replace(/\D/g,'').slice(0,8));
  $('bookingDate').min = today();
  $('bookingDate').value = today();
  $('bookingForm').addEventListener('submit',event=>{
    event.preventDefault();
    if (!validateBooking()) return;
    const service = selectedService();
    openBookingModal({
      ownerName:$('ownerName').value.trim(),
      ownerPhone:$('ownerPhone').value.replace(/\D/g,''),
      ownerEmail:$('ownerEmail').value.trim(),
      petName:$('petName').value.trim(),
      species:$('petSpecies').value,
      petAge:$('petAge').value.trim(),
      serviceId:service.id,
      serviceName:service.name,
      priceLabel:service.priceLabel || money(service.priceValue),
      priceValue:service.priceValue,
      duration:service.duration,
      date:$('bookingDate').value,
      time:$('bookingTime').value,
      note:$('bookingNote').value.trim()
    });
  });
  $('confirmBooking').addEventListener('click',confirmBooking);
  $('cancelModal').addEventListener('click',closeBookingModal);
  $('modalClose').addEventListener('click',closeBookingModal);
  $('bookingModal').addEventListener('click',event=>{if(event.target===$('bookingModal'))closeBookingModal()});
  $('themeToggle').addEventListener('click',()=>{
    document.body.classList.toggle('dark-theme');
    const dark = document.body.classList.contains('dark-theme');
    try { localStorage.setItem(THEME_KEY,dark?'dark':'light'); } catch (_) {}
    $('themeToggle').textContent = dark?'☀':'◐';
    $('themeToggle').setAttribute('aria-pressed',String(dark));
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = dark ? '#151f1a' : '#f7f6f1';
  });
  $('menuToggle').addEventListener('click',()=>{
    menuOpen = !menuOpen;
    $('mobileNav').classList.toggle('open',menuOpen);
    $('menuToggle').setAttribute('aria-expanded',String(menuOpen));
    $('menuToggle').setAttribute('aria-label',menuOpen?'Cerrar menú':'Abrir menú');
    $('menuToggle').textContent = menuOpen?'×':'☰';
  });
  $('loginMode').addEventListener('click',()=>setAuthMode('login'));
  $('signupMode').addEventListener('click',()=>setAuthMode('signup'));
  $('authForm').addEventListener('submit',handleAuth);
  $('forgotPassword').addEventListener('click',resetPassword);
  $('signOutButton').addEventListener('click',handleSignOut);
  $('profileForm').addEventListener('submit',saveProfile);
  $('profilePhone').addEventListener('input',event=>event.target.value=event.target.value.replace(/\D/g,'').slice(0,8));
  $('accountPhone').addEventListener('input',event=>event.target.value=event.target.value.replace(/\D/g,'').slice(0,8));
  $('petForm').addEventListener('submit',savePet);
  $('medicalRecordForm').addEventListener('submit',saveMedicalRecord);
  $('staffActivationForm').addEventListener('submit',activateClinicStaff);
  $('downloadClinicBackup').addEventListener('click',downloadClinicBackup);
  $('restoreClinicBackup').addEventListener('click',()=>$('clinicBackupFile').click());
  $('clinicBackupFile').addEventListener('change',restoreClinicBackup);
  document.addEventListener('keydown',event=>{
    if (event.key==='Escape') {
      closeBookingModal();
      closeMenu();
    }
    if (event.key==='/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
      event.preventDefault();
      $('serviceSearch').focus();
    }
  });
}

function closeMenu() {
  menuOpen = false;
  $('mobileNav').classList.remove('open');
  $('menuToggle').setAttribute('aria-expanded','false');
  $('menuToggle').setAttribute('aria-label','Abrir menú');
  $('menuToggle').textContent = '☰';
}

function updateNetwork() {
  const status = $('networkStatus');
  if (!navigator.onLine) {
    status.dataset.state = 'offline';
    status.querySelector('b').textContent = 'Offline';
    return;
  }
  status.dataset.state = client ? 'online' : 'offline';
  status.querySelector('b').textContent = client ? 'Online' : 'Sin conexión';
}

async function checkConnection() {
  updateNetwork();
  if (!navigator.onLine || !client) return;
  const result = await client.from('services_catalog').select('id',{head:true,count:'exact'});
  const online = !result.error;
  $('networkStatus').dataset.state = online?'online':'offline';
  $('networkStatus').querySelector('b').textContent = online?'Online':'Sin conexión';
}

function initCoreVitalsDiagnostics() {
  if (!('PerformanceObserver' in window)) return;
  const metrics = { lcp: null, cls: 0 };
  const observers = [];
  try {
    const lcpObserver = new PerformanceObserver(list => {
      const entries = list.getEntries();
      if (entries.length) metrics.lcp = Math.round(entries[entries.length - 1].startTime);
    });
    lcpObserver.observe({type:'largest-contentful-paint',buffered:true});
    observers.push(lcpObserver);
  } catch (_) {}
  try {
    const clsObserver = new PerformanceObserver(list => {
      list.getEntries().forEach(entry => {
        if (!entry.hadRecentInput) metrics.cls += entry.value;
      });
    });
    clsObserver.observe({type:'layout-shift',buffered:true});
    observers.push(clsObserver);
  } catch (_) {}
  const finish = () => {
    observers.forEach(observer => observer.disconnect());
    if (window.console && console.info) {
      console.info('[Pata Andina · Rendimiento]', {
        LCP_ms: metrics.lcp,
        CLS: Number(metrics.cls.toFixed(4))
      });
    }
  };
  window.addEventListener('pagehide',finish,{once:true});
}

async function init() {
  try {
    if (localStorage.getItem(THEME_KEY)==='dark') {
      document.body.classList.add('dark-theme');
      $('themeToggle').textContent = '☀';
      $('themeToggle').setAttribute('aria-pressed','true');
      const themeMeta = document.querySelector('meta[name="theme-color"]');
      if (themeMeta) themeMeta.content = '#151f1a';
    }
  } catch (_) {}
  bindEvents();
  bindPhotoFallbacks();
  initCoreVitalsDiagnostics();
  setAuthMode('login');
  if (!initSupabase()) {
    setStatus('authStatus','No se pudo cargar Supabase. Revisa tu conexión y vuelve a cargar la página.',true);
    $('networkStatus').dataset.state = 'offline';
    $('networkStatus').querySelector('b').textContent = 'Sin conexión';
  } else {
    client.auth.onAuthStateChange((event,sessionData)=>{
      if (event==='SIGNED_OUT') {
        recoveringPassword = false;
        currentUser = null;
        currentProfile = null;
        currentPets = [];
        isStaff = false;
        syncStaffNavigation();
        guardStaffRoute();
        $('accountDashboard').hidden = true;
        $('authPanel').hidden = false;
        setAuthMode('login');
        renderAppointments();
      } else if (event==='PASSWORD_RECOVERY' && sessionData && sessionData.user) {
        recoveringPassword = true;
        currentUser = sessionData.user;
        $('accountDashboard').hidden = true;
        $('authPanel').hidden = false;
        setAuthMode('recovery');
        setStatus('authStatus','Escribe tu nueva contraseña para completar la recuperación.');
      } else if (sessionData && sessionData.user && event==='SIGNED_IN') {
        recoveringPassword = false;
        currentUser = sessionData.user;
        setTimeout(()=>showSignedIn().catch(error=>toast(safeError(error),true)),0);
      }
    });
    const session = await client.auth.getSession();
    if (session.error) setStatus('authStatus',safeError(session.error),true);
    if (session.data && session.data.session) {
      const userResult = await client.auth.getUser();
      if (!userResult.error && userResult.data.user) {
        currentUser = userResult.data.user;
        const recoveryLink = new URLSearchParams(location.hash.replace(/^#/,'')).get('type') === 'recovery';
        if (recoveringPassword || recoveryLink) {
          recoveringPassword = true;
          $('accountDashboard').hidden = true;
          $('authPanel').hidden = false;
          setAuthMode('recovery');
          setStatus('authStatus','Escribe tu nueva contraseña para completar la recuperación.');
        } else {
          await showSignedIn();
        }
      }
    }
  }
  renderAppointments();
  await loadServices();
  await loadFoods();
  checkConnection();
  window.addEventListener('online',checkConnection);
  window.addEventListener('offline',updateNetwork);
  guardStaffRoute();
  if ('serviceWorker' in navigator && location.protocol==='https:') {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
}

if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});
else init();
})();