const express = require('express');
const client = require('prom-client');
const k8s = require('@kubernetes/client-node');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIG ---
const NAMESPACE = process.env.POD_NAMESPACE || 'ops-commander';
const MY_POD_NAME = process.env.HOSTNAME || 'unknown';
console.log(`🚀 Commander API starting in namespace: ${NAMESPACE}`);

// --- K8S & METRICS ---
const kc = new k8s.KubeConfig();
kc.loadFromCluster();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const watch = new k8s.Watch(kc);

const register = new client.Registry();
client.collectDefaultMetrics({ register });
const stressGauge = new client.Gauge({ name: 'app_stress_mode_active', help: 'Stress mode active' });
const killCounter = new client.Counter({ name: 'app_chaos_pods_killed_total', help: 'Pods killed' });
register.registerMetric(stressGauge);
register.registerMetric(killCounter);

// --- STATE ---
let isStressed = false;
let stressInterval = null;
let safetyTimer = null;
let clients = [];

// --- EVENT STREAM ---
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.push(res);
    req.on('close', () => clients = clients.filter(c => c !== res));
});

function broadcast(type, data) {
    const payload = JSON.stringify({ type, timestamp: new Date().toISOString(), ...data });
    clients.forEach(c => c.write(`data: ${payload}\n\n`));
}
// Heartbeat
setInterval(() => clients.forEach(c => c.write(`: heartbeat\n\n`)), 15000);

// --- WATCHER ---
async function startWatching() {
    const path = `/api/v1/namespaces/${NAMESPACE}/pods`;
    watch.watch(path, { labelSelector: 'app=commander-api' },
        (type, apiObj) => {
            let status = apiObj.status.phase;
            if (apiObj.metadata.deletionTimestamp) status = 'Terminating';

            broadcast('K8S_EVENT', {
                k8s_type: type,
                pod: apiObj.metadata.name,
                status: status
            });
        },
        (err) => setTimeout(startWatching, 5000)
    );
}
startWatching();

// --- LOGIC HELPER: LOCAL STRESS ---
function setLocalStress(active) {
    if (active && !isStressed) {
        isStressed = true;
        stressGauge.set(1);
        // Aggressive Burn
        stressInterval = setInterval(() => {
            const start = Date.now();
            while (Date.now() - start < 50) { Math.sqrt(Math.random()); }
        }, 20);

        // Safety: Auto-off after 5 mins
        clearTimeout(safetyTimer);
        safetyTimer = setTimeout(() => setLocalStress(false), 300000);

    } else if (!active && isStressed) {
        isStressed = false;
        stressGauge.set(0);
        clearInterval(stressInterval);
        clearTimeout(safetyTimer);
    }
}

// --- API ENDPOINTS ---

app.get('/api/status', async (req, res) => {
    try {
        const pods = await k8sApi.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, 'app=commander-api');
        res.json({
            stress_active: isStressed,
            pods: pods.body.items.map(p => ({
                name: p.metadata.name,
                status: p.metadata.deletionTimestamp ? 'Terminating' : p.status.phase
            }))
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 1. MAIN ENDPOINT (Receives UI click)
app.post('/api/stress', async (req, res) => {
    const { active } = req.body;

    // 1. Update LOCAL state immediately
    setLocalStress(active);

    // 2. Broadcast to SIBLINGS (The Fan-Out)
    try {
        const pods = await k8sApi.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, 'app=commander-api');

        // Loop through all pods and tell them to update
        pods.body.items.forEach(pod => {
            const podIP = pod.status.podIP;
            if (podIP) {
                // Fire and forget
                fetch(`http://${podIP}:8080/api/sync`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ active })
                }).catch(err => console.error(`Failed to sync ${pod.metadata.name}:`, err.message));
            }
        });

        broadcast('SYSTEM_ALERT', {
            level: active ? 'warning' : 'success',
            msg: active ? "🔥 STRESS: SYNCING ALL PODS..." : "🧊 COOLING DOWN ALL PODS..."
        });

    } catch (e) { console.error("Fan-out failed", e); }

    res.json({ status: active });
});

// 2. INTERNAL ENDPOINT
app.post('/api/sync', (req, res) => {
    const { active } = req.body;
    console.log(`📡 Received Sync Command: Stress=${active}`);
    setLocalStress(active);
    res.json({ ack: true });
});

// 3. KILL ENDPOINT
app.post('/api/kill', async (req, res) => {
    try {
        const pods = await k8sApi.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, 'app=commander-api');
        const list = pods.body.items.filter(p => !p.metadata.deletionTimestamp);

        if (list.length === 0) return res.status(500).json({ error: "No healthy pods!" });

        const victim = list[Math.floor(Math.random() * list.length)].metadata.name;
        broadcast('CHAOS_EVENT', { msg: `💀 ASSASSINATION ORDERED: ${victim}` });

        await k8sApi.deleteNamespacedPod(victim, NAMESPACE);
        killCounter.inc();
        res.json({ killed: victim });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- METRICS FIX (The Important Part) ---
app.get('/metrics', async (req, res) => {
    // This tells Prometheus: "The data is text, version 0.0.4"
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
});

app.listen(8080, () => console.log(`Commander API running on 8080 in ${NAMESPACE}`));
