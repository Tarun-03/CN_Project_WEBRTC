document.addEventListener('DOMContentLoaded', () => {
    // This connects to the Socket.IO server
    
    // vvv THIS WAS THE PROBLEM vvv
    // const socket = io('https://your-webrtc-backend-url.onrender.com'); 
    
    // vvv THIS IS THE FIX vvv
    // Connects to your local server
    const socket = io(); 

    // --- Global State ---
    let localStream = null;
    let currentRoom = '';
    let currentUsername = '';
    const peerConnections = {}; // Stores all RTCPeerConnection objects, keyed by socket ID
    const STUN_SERVER = {
        'iceServers': [
            { 'urls': 'stun:stun.l.google.com:19302' }
        ]
    };

    // --- DOM Elements ---
    const joinContainer = document.getElementById('join-container');
    const appContainer = document.getElementById('app-container');
    const joinBtn = document.getElementById('join-btn');
    const usernameInput = document.getElementById('username-input');
    const roomInput = document.getElementById('room-input');
    
    const roomHeader = document.getElementById('room-header');
    const videoGrid = document.getElementById('video-grid');
    
    const toggleMicBtn = document.getElementById('toggle-mic-btn');
    const toggleCamBtn = document.getElementById('toggle-cam-btn');
    const exitBtn = document.getElementById('exit-btn');
    
    const messages = document.getElementById('messages');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    
    // NEW: File input element
    const fileInput = document.getElementById('file-input');


    // --- 1. Join Logic ---

    joinBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const room = roomInput.value.trim();

        if (username && room) {
            currentUsername = username;
            currentRoom = room;

            try {
                // Get local audio and video stream
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                
                // Show the main app
                joinContainer.style.display = 'none';
                appContainer.style.display = 'flex';
                roomHeader.textContent = `Room: ${room}`;

                // Add local video stream to the grid
                addVideoStream('local', localStream, currentUsername, true); // Muted for self

                // Setup media control buttons
                setupMediaControls();
                
                // Emit 'join-room' event to the server
                socket.emit('join-room', { username, room });

            } catch (error) {
                console.error('Error accessing media devices.', error);
                alert('Could not access camera or microphone. Please check permissions.');
            }
        } else {
            alert('Please enter a username and room code.');
        }
    });

    // --- 2. Media Control Logic ---

    function setupMediaControls() {
        toggleMicBtn.addEventListener('click', () => {
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                toggleMicBtn.textContent = audioTrack.enabled ? 'Mute Mic' : 'Unmute Mic';
                toggleMicBtn.classList.toggle('active', audioTrack.enabled);
            }
        });

        toggleCamBtn.addEventListener('click', () => {
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                toggleCamBtn.textContent = videoTrack.enabled ? 'Hide Camera' : 'Show Camera';
                toggleCamBtn.classList.toggle('active', videoTrack.enabled);
            }
        });

        exitBtn.addEventListener('click', () => {
            window.location.reload();
        });
        
        // Set initial button state
        toggleMicBtn.classList.add('active');
        toggleCamBtn.classList.add('active');
    }

    // --- 3. Text Chat & File Logic ---

    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = messageInput.value.trim();
        
        if (message && currentRoom) {
            socket.emit('chat-message', { room: currentRoom, message });
            messageInput.value = '';
        }
    });

    socket.on('new-message', ({ username, message }) => {
        addChatMessage(username, message);
    });

    // NEW: File input listener
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) {
            return;
        }

        const reader = new FileReader();
        
        reader.onload = (event) => {
            const fileData = {
                room: currentRoom,
                file: event.target.result, // This is an ArrayBuffer
                filename: file.name,
                filetype: file.type
            };
            socket.emit('file-share', fileData);
        };
        
        reader.readAsArrayBuffer(file);

        // Reset file input
        e.target.value = null;
    });

    // NEW: Listener for incoming files
    socket.on('new-file', (payload) => {
        addFileMessage(payload);
    });


    // --- 4. Socket Event Handlers (WebRTC) ---

    // 'joined-room': Fired when WE successfully join.
    socket.on('joined-room', ({ room, otherUsers }) => {
        addNotificationMessage('You have joined the room!');
        
        // For each existing user, create a peer connection and an offer
        otherUsers.forEach(user => {
            console.log(`Creating peer for existing user: ${user.username} (${user.id})`);
            const pc = createPeerConnection(user.id, user.username);
            
            // Create and send an offer
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    socket.emit('offer', {
                        target: user.id,
                        sdp: pc.localDescription
                    });
                })
                .catch(e => console.error("Offer creation failed", e));
        });
    });

    // 'user-joined': Fired when SOMEONE ELSE joins the room.
    socket.on('user-joined', ({ id, username }) => {
        addNotificationMessage(`${username} joined the room`);
        console.log(`New user joined, creating peer: ${username} (${id})`);
        
        // Create a peer connection for the new user, they will send an offer
        createPeerConnection(id, username);
    });

    // 'offer': Fired when we receive an offer from a peer.
    socket.on('offer', (payload) => {
        console.log(`Received offer from ${payload.username} (${payload.source})`);
        const pc = createPeerConnection(payload.source, payload.username);
        
        pc.setRemoteDescription(new RTCSessionDescription(payload.sdp))
            .then(() => pc.createAnswer())
            .then(answer => pc.setLocalDescription(answer))
            .then(() => {
                socket.emit('answer', {
                    target: payload.source,
                    sdp: pc.localDescription
                });
            })
            .catch(e => console.error("Answer creation failed", e));
    });

    // 'answer': Fired when we receive an answer to our offer.
    socket.on('answer', (payload) => {
        console.log(`Received answer from ${payload.source}`);
        const pc = peerConnections[payload.source];
        if (pc) {
            pc.setRemoteDescription(new RTCSessionDescription(payload.sdp))
                .catch(e => console.error("Failed to set remote description", e));
        }
    });

    // 'ice-candidate': Fired when we receive an ICE candidate from a peer.
    socket.on('ice-candidate', (payload) => {
        const pc = peerConnections[payload.source];
        if (pc && payload.candidate) {
            pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
                .catch(e => console.error("Failed to add ICE candidate", e));
        }
    });

    // 'user-left': Fired when someone leaves the room.
    socket.on('user-left', ({ id, username }) => {
        addNotificationMessage(`${username} left the room`);
        
        // Clean up the connection and remove the video element
        if (peerConnections[id]) {
            peerConnections[id].close();
            delete peerConnections[id];
        }
        removeVideoStream(id);
    });

    // --- 5. WebRTC Helper Functions ---

    /**
     * Creates, configures, and stores a new RTCPeerConnection object.
     */
    function createPeerConnection(peerId, username) {
        // If connection already exists, return it
        if (peerConnections[peerId]) {
            return peerConnections[peerId];
        }

        const pc = new RTCPeerConnection(STUN_SERVER);

        // --- Configure event handlers ---

        // 'onicecandidate': Send any generated ICE candidates to the peer
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', {
                    target: peerId,
                    candidate: event.candidate
                });
            }
        };

        // 'ontrack': Fired when the remote stream is added
        pc.ontrack = (event) => {
            console.log(`Received remote track from ${username} (${peerId})`);
            addVideoStream(peerId, event.streams[0], username, false); // Not muted
        };

        // Add local tracks to the connection
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        } else {
            console.error("Local stream is not ready when creating peer connection");
        }
        
        // Store the connection
        peerConnections[peerId] = pc;
        return pc;
    }

    // --- 6. DOM Manipulation Functions ---

    /**
     * Adds a video stream to the video grid.
     */
    function addVideoStream(id, stream, username, isMuted) {
        // Check if video element already exists
        if (document.getElementById(`video-${id}`)) {
            return;
        }

        const videoContainer = document.createElement('div');
        videoContainer.id = `video-${id}`;
        videoContainer.classList.add('video-container');
        if(id !== 'local') {
            videoContainer.classList.add('remote-video');
        }

        const video = document.createElement('video');
        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = isMuted; // Mute self, but not others

        const usernameTag = document.createElement('div');
        usernameTag.classList.add('username-tag');
        usernameTag.textContent = username;

        videoContainer.appendChild(video);
        videoContainer.appendChild(usernameTag);
        videoGrid.appendChild(videoContainer);
    }

    /**
     * Removes a video stream from the grid.
     */
    function removeVideoStream(id) {
        const videoElement = document.getElementById(`video-${id}`);
        if (videoElement) {
            videoElement.remove();
        }
    }

    /**
     * Adds a chat message to the chatbox.
     */
    function addChatMessage(username, message) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message');

        if (username === currentUsername) {
            messageElement.classList.add('mine');
            messageElement.innerHTML = `<span>${message}</span>`;
        } else {
            messageElement.classList.add('other');
            messageElement.innerHTML = `<strong>${username}</strong><span>${message}</span>`;
        }
        
        messages.appendChild(messageElement);
        scrollToBottom();
    }
    
    /**
     * NEW: Adds a file message (image preview or download link) to the chatbox.
     */
    function addFileMessage(payload) {
        const { username, file, filename, filetype } = payload;
        
        const messageElement = document.createElement('div');
        messageElement.classList.add('message');

        // Create a Blob from the ArrayBuffer
        const blob = new Blob([file], { type: filetype });
        const url = URL.createObjectURL(blob);

        let fileContentElement;

        if (filetype.startsWith('image/')) {
            // It's an image, create an <img> preview
            fileContentElement = document.createElement('img');
            fileContentElement.src = url;
            fileContentElement.classList.add('file-preview');
            fileContentElement.alt = filename;
            // Optional: open in new tab on click
            fileContentElement.onclick = () => window.open(url, '_blank');
        } else {
            // It's a different file, create a download link
            fileContentElement = document.createElement('a');
            fileContentElement.href = url;
            fileContentElement.download = filename; // This makes it a download link
            fileContentElement.textContent = `Download ${filename}`;
            fileContentElement.classList.add('file-download');
        }

        if (username === currentUsername) {
            messageElement.classList.add('mine');
            messageElement.appendChild(fileContentElement);
        } else {
            messageElement.classList.add('other');
            const usernameTag = document.createElement('strong');
            usernameTag.textContent = username;
            messageElement.appendChild(usernameTag);
            messageElement.appendChild(fileContentElement);
        }
        
        messages.appendChild(messageElement);
        scrollToBottom();
        
        // Note: Object URLs should be revoked to free memory,
        // but for a chat app, we'll keep them
        // unless the chat is cleared.
        // URL.revokeObjectURL(url); // Don't do this here
    }

    /**
     * Adds a notification (e.g., "User joined") to the chatbox.
     */
    function addNotificationMessage(message) {
        const notificationElement = document.createElement('div');
        notificationElement.classList.add('notification');
        notificationElement.textContent = message;
        messages.appendChild(notificationElement);
        scrollToBottom();
    }

    function scrollToBottom() {
        messages.scrollTop = messages.scrollHeight;
    }
});