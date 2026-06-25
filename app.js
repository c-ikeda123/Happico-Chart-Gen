document.addEventListener('DOMContentLoaded', () => {
    const themeCheckbox = document.getElementById('checkbox');
    const difficultySlider = document.getElementById('difficulty');
    const difficultyVal = document.getElementById('difficulty-val');
    const jackFreqSlider = document.getElementById('jackFreq');
    const jackFreqVal = document.getElementById('jackFreq-val');
    const bpmInput = document.getElementById('bpm');
    const generateBtn = document.getElementById('generate-btn');

    // Theme toggle
    themeCheckbox.addEventListener('change', (e) => {
        if (e.target.checked) {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
    });

    // Sliders
    difficultySlider.addEventListener('input', (e) => {
        difficultyVal.textContent = e.target.value;
    });

    jackFreqSlider.addEventListener('input', (e) => {
        jackFreqVal.textContent = e.target.value;
    });

    // --- Firebase Configuration Placeholder ---
    // ここにご自身のFirebase設定オブジェクトを貼り付けてください
    const firebaseConfig = {
        apiKey: "AIzaSyDT_jOPOEbtvunQPKUBVlHheGEwQIxKeHc",
        authDomain: "happico-charts.firebaseapp.com",
        databaseURL: "https://happico-charts-default-rtdb.firebaseio.com",
        projectId: "happico-charts",
        storageBucket: "happico-charts.firebasestorage.app",
        messagingSenderId: "980968085206",
        appId: "1:980968085206:web:d2adb9d87bf83fa84e5b77",
        measurementId: "G-R04TWT62LP"
    };

    let isFirebaseReady = false;
    if (firebaseConfig.apiKey) {
        firebase.initializeApp(firebaseConfig);
        isFirebaseReady = true;
    }
    const db = isFirebaseReady ? firebase.database() : null;
    const chartsRef = db ? db.ref('charts') : null;

    function generateBMS(bpm, difficulty, jackFreq, idStr, seed) {
        if (typeof BASE_BMS === 'undefined') {
            alert('Error: Base BMS data not found.');
            return '';
        }

        // Initialize seeded random generator
        const rng = new Math.seedrandom(seed);

        const lines = BASE_BMS.split('\n');
        let outLines = [];
        const KEY_CHANNELS = ["11", "12", "13", "14", "15", "18", "19"];

        // Probability of assigning a note to a key.
        // Diff 1 = 21.5% (equivalent to 03_happico_A.bms density)
        // Diff 20 = 100%
        const noteProb = 0.215 + ((difficulty - 1) * 0.0413);
        
        const jacksPer4Measures = jackFreq * 2; // e.g. jackFreq 1 => 2 jacks per 4 measures

        const RESOLUTION = 192; // 192 ticks per measure. 16th note = 12 ticks.
        const TICK_16TH = RESOLUTION / 16; // 12

        let measuresKeys = {}; // measuresKeys[m][ch][tick]
        let bgmDefinitions = []; // store parsed #xxx01 lines
        let maxMeasure = 0;

        // Pass 1: Parse the file, extract #xxx01 lines
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line === '') {
                outLines.push(line);
                continue;
            }
            if (line.toUpperCase().startsWith('#BPM ')) {
                outLines.push(`#BPM ${bpm}`);
                continue;
            }
            if (line.toUpperCase().startsWith('#ARTIST ')) {
                outLines.push(`#ARTIST しらいし`);
                outLines.push(`#SUBARTIST obj:Happico Happico Chart Generator`);
                outLines.push(`#SUBTITLE [${idStr}]`);
                continue;
            }
            if (line.toUpperCase().startsWith('#SUBARTIST ')) continue;
            if (line.toUpperCase().startsWith('#SUBTITLE ')) continue;

            const match = line.match(/^#(\d{3})01:(.+)$/);
            if (match) {
                const mStr = match[1];
                const mNum = parseInt(mStr, 10);
                if (mNum > maxMeasure) maxMeasure = mNum;

                const dataStr = match[2];
                const res = dataStr.length / 2;
                if (RESOLUTION % res !== 0) {
                    outLines.push(line);
                    continue;
                }

                let notes = [];
                for (let s = 0; s < res; s++) {
                    notes.push(dataStr.substring(s * 2, s * 2 + 2));
                }

                bgmDefinitions.push({
                    measureStr: mStr,
                    measureNum: mNum,
                    res: res,
                    multiplier: RESOLUTION / res,
                    notes: notes,
                    originalLineIndex: outLines.length // we will insert a placeholder
                });
                outLines.push(null); // placeholder for modified bgm line
            } else if (line.match(/^#\d{3}(03|08):/)) {
                // Ignore mid-song BPM changes (e.g., at measure 000) from the base chart
                continue;
            } else {
                outLines.push(line);
            }
        }

        function getMeasureData(mNum) {
            if (!measuresKeys[mNum]) {
                measuresKeys[mNum] = {};
                KEY_CHANNELS.forEach(ch => {
                    measuresKeys[mNum][ch] = new Array(RESOLUTION).fill("00");
                });
            }
            return measuresKeys[mNum];
        }

        // Pass 2: Chronological assignment
        let currentJacks = 0;
        let lastUsedTick = {};
        KEY_CHANNELS.forEach(ch => lastUsedTick[ch] = -9999);

        function getCombinations(arr, k) {
            if (k === 0) return [[]];
            if (arr.length === 0) return [];
            let first = arr[0];
            let rest = arr.slice(1);
            let withFirst = getCombinations(rest, k - 1).map(c => [first, ...c]);
            let withoutFirst = getCombinations(rest, k);
            return withFirst.concat(withoutFirst);
        }

        for (let m = 0; m <= maxMeasure; m++) {
            if (m % 4 === 0) {
                currentJacks = 0; // reset jack counter every 4 measures
            }

            const measureObj = getMeasureData(m);

            // Track chord repetitions in this measure
            let chordCounts = {};
            let bannedChords = [];

            // Find all bgm lines for this measure
            const mLines = bgmDefinitions.filter(d => d.measureNum === m);

            for (let tick = 0; tick < RESOLUTION; tick++) {
                let currentAbsTick = m * RESOLUTION + tick;

                // Find all notes across all bgm lines on this tick
                let notesAtTick = [];
                mLines.forEach(def => {
                    if (tick % def.multiplier === 0) {
                        const step = tick / def.multiplier;
                        const note = def.notes[step];
                        if (note !== "00") {
                            notesAtTick.push({ def, step, note });
                        }
                    }
                });

                let notesToAssign = notesAtTick.filter(n => rng() < noteProb);
                let K = notesToAssign.length;

                if (K > 0) {
                    if (K > KEY_CHANNELS.length) K = KEY_CHANNELS.length;

                    let prevKeysUsed = KEY_CHANNELS.filter(ch => (currentAbsTick - lastUsedTick[ch]) <= TICK_16TH);

                    let combs = getCombinations(KEY_CHANNELS, K);

                    // Ban identical simultaneous presses that have occurred >= 2 times
                    if (K >= 2) {
                        let validCombs = combs.filter(c => !bannedChords.includes([...c].sort().join(",")));
                        if (validCombs.length > 0) combs = validCombs;
                    }

                    // Apply jack logic
                    if (jackFreq === 0) {
                        let noJackCombs = combs.filter(c => c.every(key => !prevKeysUsed.includes(key)));
                        if (noJackCombs.length > 0) {
                            combs = noJackCombs;
                        } else {
                            // Forcefully reduce K to avoid jacks
                            let safeKeys = KEY_CHANNELS.filter(ch => !prevKeysUsed.includes(ch));
                            K = safeKeys.length;
                            if (K > 0) {
                                combs = getCombinations(safeKeys, K);
                                if (K >= 2) {
                                    let validCombs = combs.filter(c => !bannedChords.includes([...c].sort().join(",")));
                                    if (validCombs.length > 0) combs = validCombs;
                                }
                            } else {
                                combs = [];
                            }
                        }
                    } else {
                        let wantsJack = (currentJacks < jacksPer4Measures);
                        if (wantsJack && prevKeysUsed.length > 0) {
                            let forceJack = rng() < 0.2 || (currentJacks === 0 && m % 4 === 3);
                            if (forceJack) {
                                let jackCombs = combs.filter(c => c.some(key => prevKeysUsed.includes(key)));
                                if (jackCombs.length > 0) combs = jackCombs;
                            } else {
                                let noJackCombs = combs.filter(c => c.every(key => !prevKeysUsed.includes(key)));
                                if (noJackCombs.length > 0) combs = noJackCombs;
                            }
                        } else {
                            let noJackCombs = combs.filter(c => c.every(key => !prevKeysUsed.includes(key)));
                            if (noJackCombs.length > 0) combs = noJackCombs;
                        }
                    }

                    if (K > 0 && combs.length > 0) {
                        let chosenComb = combs[Math.floor(rng() * combs.length)];

                        let createdJacks = chosenComb.filter(k => prevKeysUsed.includes(k)).length;
                        if (createdJacks > 0) currentJacks++;

                        if (K >= 2) {
                            let cStr = [...chosenComb].sort().join(",");
                            chordCounts[cStr] = (chordCounts[cStr] || 0) + 1;
                            if (chordCounts[cStr] >= 2) {
                                bannedChords.push(cStr);
                            }
                        }

                        for (let i = 0; i < K; i++) {
                            let nInfo = notesToAssign[i];
                            nInfo.def.notes[nInfo.step] = "00";
                            let ch = chosenComb[i];
                            measureObj[ch][tick] = nInfo.note;
                            lastUsedTick[ch] = currentAbsTick;
                        }
                    }
                }
            }

            // Reconstruct BGM lines
            mLines.forEach(def => {
                const newBgmData = def.notes.join("");
                if (newBgmData !== "00".repeat(def.res)) {
                    outLines[def.originalLineIndex] = `#${def.measureStr}01:${newBgmData}`;
                } else {
                    outLines[def.originalLineIndex] = ""; // empty string so it doesn't output
                }
            });
        }

        // Clean up placeholders in outLines
        outLines = outLines.filter(l => l !== null && l !== "");

        outLines.push("");
        outLines.push("*---------------------- AUTO GENERATED KEYS");

        function shrinkArray(arr) {
            let gcd = RESOLUTION;
            for (let i = 0; i < RESOLUTION; i++) {
                if (arr[i] !== "00") {
                    let a = gcd;
                    let b = i;
                    while (b !== 0) {
                        let temp = b;
                        b = a % b;
                        a = temp;
                    }
                    gcd = a;
                }
            }
            if (gcd === 0) return [];
            let result = [];
            for (let i = 0; i < RESOLUTION; i += gcd) {
                result.push(arr[i]);
            }
            return result;
        }

        for (const [m, channels] of Object.entries(measuresKeys)) {
            let mStr = String(m).padStart(3, '0');
            for (const [ch, arr] of Object.entries(channels)) {
                const isAllZero = arr.every(x => x === "00");
                if (!isAllZero) {
                    const shrunk = shrinkArray(arr);
                    outLines.push(`#${mStr}${ch}:${shrunk.join("")}`);
                }
            }
        }

        return outLines.join("\n");
    }

    generateBtn.addEventListener('click', async () => {
        const bpm = parseInt(bpmInput.value) || 175;
        const difficulty = parseInt(difficultySlider.value) || 5;
        const jackFreq = parseInt(jackFreqSlider.value) || 0; // Default to 0
        
        // Disable button while generating
        generateBtn.disabled = true;
        generateBtn.textContent = '生成中...';

        let chartId = 1;
        if (!isFirebaseReady) {
            alert('Firebaseが設定されていません。ローカルテスト用IDで生成します。');
            chartId = Math.floor(Math.random() * 10000);
        } else {
            try {
                const counterRef = db.ref('globalCounter');
                const result = await counterRef.transaction((currentValue) => {
                    return (currentValue || 0) + 1;
                });
                if (result.committed) {
                    chartId = result.snapshot.val();
                } else {
                    throw new Error("Transaction aborted");
                }
            } catch (err) {
                console.error("ID取得エラー", err);
                alert("データベースからのID取得に失敗しました。Firebaseのルール設定（Rules）が読み書き許可になっているか確認してください。\n\n詳細: " + err.message);
                generateBtn.disabled = false;
                generateBtn.textContent = 'BMS譜面を生成して共有';
                return;
            }
        }
        
        const idStr = String(chartId).padStart(4, '0');
        
        // Generate a random seed
        const seed = Date.now().toString(36) + Math.random().toString(36).substr(2);

        const bmsContent = generateBMS(bpm, difficulty, jackFreq, idStr, seed);

        if (!bmsContent) {
            generateBtn.disabled = false;
            generateBtn.textContent = 'BMS譜面を生成して共有';
            return;
        }
        
        // Calculate MD5 of the Shift-JIS file content for the difficulty table
        const unicodeArray = Encoding.stringToCode(bmsContent);
        const sjisArray = Encoding.convert(unicodeArray, { to: 'SJIS', from: 'UNICODE' });
        const uint8Array = new Uint8Array(sjisArray);
        const md5Hash = SparkMD5.ArrayBuffer.hash(uint8Array);

        // Upload to Firebase
        if (isFirebaseReady) {
            const chartData = {
                idStr: idStr,
                bpm: bpm,
                difficulty: difficulty,
                jackFreq: jackFreq,
                seed: seed,
                timestamp: firebase.database.ServerValue.TIMESTAMP,
                good: 0,
                bad: 0
            };
            chartsRef.push(chartData);
            
            // Push to tableData for Difficulty Table compatibility
            const tableRef = db.ref('tableData');
            tableRef.transaction((currentArray) => {
                let arr = currentArray || [];
                arr.push({
                    title: `Happico Happico [${idStr}]`,
                    artist: "しらいし",
                    url: window.location.href, // Link back to the generator site
                    md5: md5Hash,
                    level: difficulty.toString()
                });
                return arr;
            });
        } else {
            alert('Firebaseが設定されていないため、タイムラインに共有されませんでした。');
        }
        
        // Re-enable button
        generateBtn.disabled = false;
        generateBtn.textContent = 'BMS譜面を生成して共有';
    });

    // --- ZIP Download Logic ---
    const dlAllBtn = document.getElementById('download-all-btn');
    if (dlAllBtn) {
        dlAllBtn.addEventListener('click', async () => {
            if (!isFirebaseReady) {
                alert('Firebaseが設定されていません。');
                return;
            }
            dlAllBtn.textContent = 'ZIP作成中...';
            dlAllBtn.disabled = true;

            try {
                const snapshot = await chartsRef.once('value');
                const data = snapshot.val();
                if (!data) {
                    alert('共有された譜面がありません。');
                    throw new Error('No data');
                }

                const zip = new JSZip();
                const folder = zip.folder('Happico_Charts');

                Object.values(data).forEach(chart => {
                    const content = generateBMS(chart.bpm, chart.difficulty, chart.jackFreq, chart.idStr, chart.seed);
                    if (content) {
                        const uArr = Encoding.stringToCode(content);
                        const sArr = Encoding.convert(uArr, { to: 'SJIS', from: 'UNICODE' });
                        folder.file(`${chart.idStr}.bms`, new Uint8Array(sArr));
                    }
                });

                const blob = await zip.generateAsync({ type: 'blob' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `Happico_All_Charts.zip`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 100);
            } catch (err) {
                console.error(err);
            }

            dlAllBtn.textContent = '全譜面を一括DL (ZIP)';
            dlAllBtn.disabled = false;
        });
    }

    // --- Timeline / Feed Logic ---
    const timelineList = document.getElementById('timeline-list');
    const searchInput = document.getElementById('search-input');
    const searchBtn = document.getElementById('search-btn');
    const resetSearchBtn = document.getElementById('reset-search-btn');
    
    // Listen for new charts
    if (isFirebaseReady) {
        timelineList.innerHTML = ''; // clear default message
        
        // Order by timestamp, fetch ALL charts
        chartsRef.orderByChild('timestamp').on('child_added', (snapshot) => {
            const data = snapshot.val();
            const key = snapshot.key;
            renderTimelineItem(key, data, true);
        });
        
        chartsRef.on('child_changed', (snapshot) => {
            const data = snapshot.val();
            const key = snapshot.key;
            updateVotes(key, data);
        });
    }
    
    if (searchBtn && resetSearchBtn && searchInput) {
        searchBtn.addEventListener('click', () => {
            let query = searchInput.value.trim();
            if (!query) return;
            
            // 数字のみの場合は0埋めした文字列も検索対象にする
            let queryPadded = query;
            if (/^\d+$/.test(query)) {
                queryPadded = String(parseInt(query, 10)).padStart(4, '0');
            }

            const items = document.querySelectorAll('.timeline-item');
            items.forEach(item => {
                const titleText = item.querySelector('.timeline-header span').textContent;
                if (titleText.includes(query) || titleText.includes(queryPadded)) {
                    item.style.display = 'flex';
                } else {
                    item.style.display = 'none';
                }
            });
        });

        // Enterキーで検索できるようにする
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                searchBtn.click();
            }
        });

        resetSearchBtn.addEventListener('click', () => {
            searchInput.value = '';
            const items = document.querySelectorAll('.timeline-item');
            items.forEach(item => {
                item.style.display = 'flex';
            });
        });
    }

    function renderTimelineItem(key, data, prepend) {
        const item = document.createElement('div');
        item.className = 'timeline-item';
        item.id = `chart-${key}`;

        const date = new Date(data.timestamp);
        const timeStr = isNaN(date) ? 'Just now' : date.toLocaleString('ja-JP');

        item.innerHTML = `
            <div class="timeline-header">
                <span>Happico Happico [${data.idStr}]</span>
                <span class="timeline-meta">${timeStr}</span>
            </div>
            <div class="timeline-tags">
                <span class="tag">BPM: ${data.bpm}</span>
                <span class="tag">難易度: ${data.difficulty}</span>
                <span class="tag">縦連: ${data.jackFreq}</span>
            </div>
            <div class="timeline-actions">
                <div class="vote-group">
                    <button class="vote-btn good-btn" data-key="${key}">👍 <span class="good-count">${data.good || 0}</span></button>
                    <button class="vote-btn bad-btn" data-key="${key}">👎 <span class="bad-count">${data.bad || 0}</span></button>
                </div>
                <button class="dl-btn" data-bpm="${data.bpm}" data-diff="${data.difficulty}" data-jack="${data.jackFreq}" data-id="${data.idStr}" data-seed="${data.seed}">
                    ダウンロード
                </button>
            </div>
        `;

        if (prepend) {
            timelineList.insertBefore(item, timelineList.firstChild);
        } else {
            timelineList.appendChild(item);
        }

        // Download event
        const dlBtn = item.querySelector('.dl-btn');
        dlBtn.addEventListener('click', () => {
            const bmsContent = generateBMS(data.bpm, data.difficulty, data.jackFreq, data.idStr, data.seed);
            if (!bmsContent) return;

            const unicodeArray = Encoding.stringToCode(bmsContent);
            const sjisArray = Encoding.convert(unicodeArray, { to: 'SJIS', from: 'UNICODE' });
            const blob = new Blob([new Uint8Array(sjisArray)], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = `${data.idStr}.bms`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
        });

        // Vote events
        const goodBtn = item.querySelector('.good-btn');
        const badBtn = item.querySelector('.bad-btn');

        goodBtn.addEventListener('click', () => handleVote(key, 'good'));
        badBtn.addEventListener('click', () => handleVote(key, 'bad'));
    }

    function updateVotes(key, data) {
        const item = document.getElementById(`chart-${key}`);
        if (item) {
            item.querySelector('.good-count').textContent = data.good || 0;
            item.querySelector('.bad-count').textContent = data.bad || 0;
        }
    }

    function handleVote(key, type) {
        if (!isFirebaseReady) return;

        const votedKey = `voted_${key}`;
        if (localStorage.getItem(votedKey)) {
            alert('すでに投票済みです！');
            return;
        }

        const ref = db.ref(`charts/${key}/${type}`);
        ref.transaction((currentValue) => {
            return (currentValue || 0) + 1;
        }, (error, committed) => {
            if (committed) {
                localStorage.setItem(votedKey, 'true');
                const item = document.getElementById(`chart-${key}`);
                if (item) {
                    item.querySelector(`.${type}-btn`).classList.add(`active-${type}`);
                }
            }
        });
    }
});
