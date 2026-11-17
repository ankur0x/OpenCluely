'use strict';

const chatImageStore = (() => {
    let database;
    function open() {
        if (!database) database = new Promise((resolve, reject) => {
            const request = indexedDB.open('opencluely-chat-attachments', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('images');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return database;
    }

    async function transaction(mode, action) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('images', mode);
            const request = action(tx.objectStore('images'));
            tx.oncomplete = () => resolve(request?.result);
            tx.onabort = () => reject(tx.error);
        });
    }

    return {
        get: id => transaction('readonly', store => store.get(id)),
        put: (id, data) => transaction('readwrite', store => store.put(data, id)),
        clear: () => transaction('readwrite', store => store.clear()),
        remove: ids => transaction('readwrite', store => ids.forEach(id => store.delete(id)))
    };
})();
