// services/taskQueue.js
class TaskQueue {
    constructor(rateLimit = Infinity, interval = 0) {
        this.queue = [];
        this.rateLimit = rateLimit;
        this.interval = interval;
        this.active = false;
    }

    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.active) return;
        this.active = true;
        while (this.queue.length > 0) {
            const { task, resolve, reject } = this.queue.shift();
            try {
                const result = await task();
                resolve(result);
            } catch (err) {
                reject(err);
            }
            if (this.interval > 0) {
                await this.sleep(this.interval / this.rateLimit);
            }
        }
        this.active = false;
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

module.exports = TaskQueue;
