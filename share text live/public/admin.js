// Shareli Admin Dashboard Interactive Controller
document.addEventListener('DOMContentLoaded', () => {
  // 1. Room Search Filter
  const searchInput = document.getElementById('room-search');
  const roomRows = Array.from(document.querySelectorAll('#rooms-tbody tr'));
  const emptySearchRow = document.getElementById('no-search-results');
  let currentFilter = 'all';

  function applyFilters() {
    const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
    let visibleCount = 0;

    roomRows.forEach(row => {
      if (row.id === 'no-search-results' || !row.dataset.roomId) return;
      const roomId = (row.dataset.roomId || '').toLowerCase();
      const roomType = (row.dataset.roomType || '').toLowerCase();
      const matchesSearch = !query || roomId.includes(query) || roomType.includes(query);
      const matchesTab = currentFilter === 'all' || roomType === currentFilter;

      if (matchesSearch && matchesTab) {
        row.style.display = '';
        visibleCount++;
      } else {
        row.style.display = 'none';
      }
    });

    if (emptySearchRow) {
      emptySearchRow.style.display = visibleCount === 0 ? '' : 'none';
    }
  }

  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }

  // 2. Room Category Filter Tabs
  const filterBtns = document.querySelectorAll('.filter-tab');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter || 'all';
      applyFilters();
    });
  });

  // 3. Click to copy Room ID
  document.querySelectorAll('.copy-room-id').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.room || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const originalText = btn.innerHTML;
        btn.innerHTML = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = originalText;
          btn.classList.remove('copied');
        }, 1200);
      } catch {
        // Fallback
      }
    });
  });

  // 4. Broadcast Character Counter & Auto-pause refresh on compose
  const broadcastInput = document.getElementById('broadcast-msg');
  const broadcastCounter = document.getElementById('broadcast-counter');
  if (broadcastInput && broadcastCounter) {
    broadcastInput.addEventListener('input', () => {
      const count = broadcastInput.value.length;
      broadcastCounter.textContent = `${count}/300`;
      broadcastCounter.style.color = count > 280 ? '#ef4444' : '#9ba1a6';
    });
  }

  // 5. Destructive Action Confirmation
  document.querySelectorAll('[data-confirm]').forEach(el => {
    el.addEventListener('click', (e) => {
      const msg = el.dataset.confirm || 'Are you sure you want to proceed?';
      if (!window.confirm(msg)) {
        e.preventDefault();
      }
    });
  });

  // 6. Interactive Auto-Refresh Countdown
  const countdownEl = document.getElementById('refresh-timer');
  const pauseBtn = document.getElementById('pause-refresh-btn');
  let secondsLeft = 30;
  let isPaused = false;

  function setPausedState(paused) {
    isPaused = paused;
    if (pauseBtn) {
      pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
      pauseBtn.classList.toggle('paused', isPaused);
    }
    if (countdownEl) {
      countdownEl.textContent = isPaused ? 'Paused' : `${secondsLeft}s`;
    }
  }

  // Auto-pause when admin is actively typing an announcement
  if (broadcastInput) {
    broadcastInput.addEventListener('focus', () => {
      if (!isPaused) setPausedState(true);
    });
  }

  if (countdownEl) {
    const timer = setInterval(() => {
      if (isPaused) return;
      secondsLeft--;
      if (secondsLeft <= 0) {
        clearInterval(timer);
        window.location.reload();
      } else {
        countdownEl.textContent = `${secondsLeft}s`;
      }
    }, 1000);

    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        setPausedState(!isPaused);
      });
    }
  }
});
