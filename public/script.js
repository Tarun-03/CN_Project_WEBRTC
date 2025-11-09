// public/script.js

document.addEventListener('DOMContentLoaded', () => {

    // --- DOM Elements ---
    const joinContainer = document.getElementById('join-container');
    const appContainer = document.getElementById('app-container');
    const joinBtn = document.getElementById('join-btn');
    const usernameInput = document.getElementById('username-input');
    const roomInput = document.getElementById('room-input');
    
    const videoGrid = document.getElementById('video-grid');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    const messagesContainer = document.getElementById('messages');
    
    const micBtn = document.getElementById('toggle-mic-btn');
    const camBtn = document.getElementById('toggle-cam-btn');
    const exitBtn = document.getElementById('exit-btn');

    // --- File Input Elements ---
    const fileInput = document.getElementById('file-input');
    const fileLabel = document.getElementById('file-label-btn');

    // --- State Variables ---
    let localUsername = '';
    let currentRoom = '';
    let localStream;
    let peers = {}; // Stores { socketId: { peer: RTCPeerConnection, username: string } }
    let statsInterval; // Holds the interval ID for monitoring stats
    
    // --- Socket.IO Connection ---
    // Connect to the Socket.IO server
    // Use io() for local, or specify URL for deployment
    const socket = io(); 
    // const socket = io('https://your-webrtc-backend-url.onrender.com');


    // --- 1. Join Logic ---

    // **RACE CONDITION FIX**: Make the join button async
    joinBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const room = roomInput.value.trim();

        if (username && room) {
            localUsername = username;
            currentRoom = room;

            try {
                // --- FIX: Await media BEFORE joining room ---
                // 1. Get local media first
                await startLocalMedia();

                // 2. If media is successful, hide join UI and show app
                joinContainer.style.display = 'none';
                appContainer.style.display = 'flex';

                // Set room header
                document.getElementById('room-header').textContent = `Room: ${currentRoom}`;

                // --- FIX: Emit join-room AFTER media is ready ---
                // 3. Now, join the room
                socket.emit('join-room', { username, room });

            } catch (error) {
                // This catch block will run if startLocalMedia() throws an error (e.g., user denies camera)
                console.error('Failed to get media or join room:', error);
                alert('Could not access camera or microphone. Please check permissions and try again.');
            }
        } else {
            alert('Please enter a username and room code.');
        }
    });

    // This function now handles getting media AND updating the UI
    async function startLocalMedia() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            addVideoStream(localStream, localUsername, socket.id, true); // Add local video, mark as 'isLocal'
            
            // Set button states
            micBtn.classList.add('active'); // Mic is on by default
            camBtn.classList.add('active'); // Cam is on by default

        } catch (error) {
            console.error('Error accessing media devices.', error);
            // --- FIX: Throw the error to be caught by the joinBtn listener ---
            throw error;
        }
    }

    // --- 2. Core Socket Handlers ---

    // Handle 'joined-room' event (this user just joined)
    socket.on('joined-room', ({ room, otherUsers }) => {
        console.log(`Successfully joined room: ${room} with ${otherUsers.length} other users.`);
        
        // Add notification for self
        addNotification(`You have joined the room: ${currentRoom}`);

        // Start performance monitoring
        if (!statsInterval) {
            statsInterval = setInterval(startMonitoringStats, 5000); // Check stats every 5 seconds
        }
        
        // --- CORRECT LOGIC (FIXED) ---
        // We are the NEW user. We will *wait* for offers from existing users.
        // We will receive 'offer' events for each user in `otherUsers`.
    });

    // Handle 'user-joined' event (someone else joined)
    socket.on('user-joined', ({ id, username }) => {
        console.log(`${username} (Socket ${id}) joined the room.`);
        
        // --- Add notification to chat ---
        addNotification(`${username} joined the room: ${currentRoom}`);
        
        // --- CORRECT LOGIC (FIXED) ---
        // We are an EXISTING user. A new user has joined.
        // Create a peer and send an offer to the new user.
        const peer = createPeerConnection(id);
        peers[id] = { peer: peer, username: username }; // Store peer and username
        
        // Add all tracks from local stream to the new peer
        // This will trigger the 'onnegotiationneeded' event, which creates and sends the offer
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peer.addTrack(track, localStream);
            });
        }
    });

    // Handle 'user-left' event
    socket.on('user-left', ({ id, username }) => {
        console.log(`${username} (Socket ${id}) left the room.`);
        addNotification(`${username} left the room.`);
        
        // Close and remove the peer connection
        if (peers[id]) {
            peers[id].peer.close();
            delete peers[id];
        }

        // Remove from stats tracking
        if (lastInboundStats[id]) {
            delete lastInboundStats[id];
        }

        // Remove the video container
        const videoContainer = document.getElementById(`video-${id}`);
        if (videoContainer) {
            videoGrid.removeChild(videoContainer);
        }
    });


    // --- 3. Chat Logic ---

    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = messageInput.value.trim();

        if (message) {
            // Emit the chat message to the server
            socket.emit('chat-message', {
                room: currentRoom,
                message: message
            });

            // --- BUG FIX (Duplicate Messages) ---
            // DO NOT add the message locally here. 
            // We will ONLY add it when we receive it back from the server.
            // addMessage(localUsername, message, true); // This was the bug

            messageInput.value = '';
        }
    });

    // Listen for new messages
    socket.on('new-message', ({ username, message }) => {
        const isMine = (username === localUsername);
        addMessage(username, message, isMine);
    });

    // Add a chat message to the UI
    function addMessage(username, message, isMine) {
        const msgDiv = document.createElement('div');
        msgDiv.classList.add('message');
        msgDiv.classList.add(isMine ? 'mine' : 'other');

        // Don't show username for your own messages
        if (!isMine) {
            const userTag = document.createElement('strong');
            userTag.textContent = username;
            msgDiv.appendChild(userTag);
        }
        
        // Create a span for the text to prevent re-parsing HTML
        const msgText = document.createElement('span');
        msgText.textContent = message;
        msgDiv.appendChild(msgText);
        
        messagesContainer.appendChild(msgDiv);
        scrollToBottom();
    }

    // Add a notification message (e.g., user join/left)
    function addNotification(message) {
        const notifDiv = document.createElement('div');
        notifDiv.classList.add('notification');
        notifDiv.textContent = message;
        messagesContainer.appendChild(notifDiv);
        scrollToBottom();
    }

    function scrollToBottom() {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }


    // --- 4. File Sharing Logic ---

    // Trigger hidden file input when "File" button is clicked
    fileLabel.addEventListener('click', () => {
        fileInput.click();
    });

    // Handle file selection
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) {
            return;
        }
        
        // Check file size (e.g., limit to 10MB, matching server config)
        if (file.size > 1e7) {
            alert('File is too large! Maximum size is 10MB.');
            fileInput.value = ''; // Reset input
            return;
        }

        // Read file as ArrayBuffer
        const reader = new FileReader();
        reader.onload = () => {
            const arrayBuffer = reader.result;
            
            // Emit the file to the server
            socket.emit('file-share', {
                room: currentRoom,
                file: arrayBuffer,
                filename: file.name,
                filetype: file.type
            });
        };
        reader.readAsArrayBuffer(file);
        
        // Reset file input to allow selecting the same file again
        fileInput.value = '';
    });

    // Listen for new files from the server
    socket.on('new-file', ({ username, file, filename, filetype }) => {
        const isMine = (username === localUsername);
        
        // The 'file' is an ArrayBuffer, convert it to a Blob
        const blob = new Blob([file], { type: filetype });
        
        addFileMessage(username, blob, filename, filetype, isMine);
    });

    // Add a file message to the UI
    function addFileMessage(username, blob, filename, filetype, isMine) {
        const msgDiv = document.createElement('div');
        msgDiv.classList.add('message');
        msgDiv.classList.add(isMine ? 'mine' : 'other');

        if (!isMine) {
            const userTag = document.createElement('strong');
            userTag.textContent = username;
            msgDiv.appendChild(userTag);
        }

        // Create a URL for the blob
        const blobUrl = URL.createObjectURL(blob);

        if (filetype.startsWith('image/')) {
            // It's an image, create an <img> preview
            const img = document.createElement('img');
            img.src = blobUrl;
            img.alt = filename;
            img.classList.add('file-preview');
            // Optional: make image clickable to open full-size in new tab
            img.onclick = () => window.open(blobUrl, '_blank');
            msgDiv.appendChild(img);

        } else {
            // It's not an image, create a download link
            const link = document.createElement('a');
            link.href = blobUrl;
            link.textContent = `Download: ${filename}`;
            link.download = filename; // This attribute triggers download
            link.classList.add('file-download');
            msgDiv.appendChild(link);
        }
        
        messagesContainer.appendChild(msgDiv);
        scrollToBottom();
    }


    // --- 5. WebRTC Logic ---

    // ICE servers configuration
    const iceServers = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    // Create a new RTCPeerConnection
    function createPeerConnection(targetSocketId) {
        const peer = new RTCPeerConnection(iceServers);

        // Handle ICE candidate event
        peer.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', {
                    target: targetSocketId,
                    candidate: event.candidate
                });
            }
        };

        // Handle remote track event
        peer.ontrack = (event) => {
            // We only care about the first stream
            if (event.streams && event.streams[0]) {
                const remoteStream = event.streams[0];
                const remoteUsername = peers[targetSocketId]?.username || 'RemoteUser';
                addVideoStream(remoteStream, remoteUsername, targetSocketId, false);
            }
        };

        // Handle negotiation needed event (e.g., when tracks are added)
        peer.onnegotiationneeded = async () => {
            console.log(`Negotiation needed for ${targetSocketId}`);
            try {
                const offer = await peer.createOffer();
                await peer.setLocalDescription(offer);
                
                socket.emit('offer', {
                    target: targetSocketId,
                    sdp: peer.localDescription
                });
            } catch (err) {
                console.error('Error creating offer:', err);
            }
        };
        
        return peer;
    }

    // Listen for 'offer' from an existing user
    socket.on('offer', async ({ source, sdp, username }) => {
        console.log(`Received offer from ${username} (Socket ${source})`);
        
        const peer = createPeerConnection(source);
        peers[source] = { peer: peer, username: username }; // Store peer and username

        try {
            await peer.setRemoteDescription(new RTCSessionDescription(sdp));

            // Add our local tracks *after* setting remote description
            if (localStream) {
                localStream.getTracks().forEach(track => {
                    peer.addTrack(track, localStream);
                });
            }

            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);

            socket.emit('answer', {
                target: source,
                sdp: peer.localDescription
            });
        } catch (err) {
            console.error('Error handling offer:', err);
        }
    });

    // Listen for 'answer' from the new user
    socket.on('answer', async ({ source, sdp }) => {
        console.log(`Received answer from Socket ${source}`);
        const peer = peers[source]?.peer;
        if (peer) {
            try {
                await peer.setRemoteDescription(new RTCSessionDescription(sdp));
            } catch (err) {
                console.error('Error setting remote description:', err);
            }
        }
    });

    // Listen for 'ice-candidate'
    socket.on('ice-candidate', async ({ source, candidate }) => {
        const peer = peers[source]?.peer;
        if (peer) {
            try {
                // Ignore empty candidates
                if (candidate) {
                    await peer.addIceCandidate(new RTCIceCandidate(candidate));
                }
            } catch (err) {
                console.error('Error adding ICE candidate:', err);
            }
        }
    });

    // Add video stream to the UI
    function addVideoStream(stream, username, socketId, isLocal = false) {
        // Don't add if a video for this ID already exists
        if (document.getElementById(`video-${socketId}`)) {
            return;
        }

        const container = document.createElement('div');
        container.classList.add('video-container');
        container.id = `video-${socketId}`;

        const videoEl = document.createElement('video');
        videoEl.srcObject = stream;
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        
        if (isLocal) {
            videoEl.muted = true; // Mute local video to prevent echo
            videoEl.style.transform = 'scaleX(-1)'; // Flip local video
        }

        const usernameTag = document.createElement('div');
        usernameTag.classList.add('username-tag');
        usernameTag.textContent = isLocal ? `${username} (You)` : username;

        container.appendChild(videoEl);
        container.appendChild(usernameTag);
        
        // Add stats display overlay (will be populated by monitoring)
        if (!isLocal) {
            const statsDisplay = document.createElement('div');
            statsDisplay.classList.add('stats-display');
            statsDisplay.id = `stats-${socketId}`;
            container.appendChild(statsDisplay);
        }

        videoGrid.appendChild(container);
    }


    // --- 6. UI Controls Logic ---

    micBtn.addEventListener('click', () => {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            micBtn.textContent = audioTrack.enabled ? 'Mute Mic' : 'Unmute Mic';
            micBtn.classList.toggle('active', audioTrack.enabled);
        }
    });

    camBtn.addEventListener('click', () => {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            camBtn.textContent = videoTrack.enabled ? 'Hide Camera' : 'Show Camera';
            camBtn.classList.toggle('active', videoTrack.enabled);
        }
    });

    exitBtn.addEventListener('click', () => {
        // Stop the stats interval
        if (statsInterval) {
            clearInterval(statsInterval);
        }
        // Reload the page to disconnect and go back to join screen
        window.location.reload();
    });
    
    
    // --- 7. Performance Monitoring Logic ---
    
    async function startMonitoringStats() {
        for (const socketId in peers) {
            const peer = peers[socketId]?.peer;
            if (peer && peer.connectionState === 'connected') {
                try {
                    const stats = await peer.getStats(null);
                    processStats(stats, socketId);
                } catch (err) {
                    console.error('Error getting stats:', err);
                }
            }
        }
    }
    
    let lastInboundStats = {}; // Store previous stats to calculate bitrate

    function processStats(stats, socketId) {
        let metrics = {
            latency: 'N/A',
            jitter: 'N/A',
            packetsLost: 0,
            bitrate: 'N/A',
            resolution: 'N/A',
            fps: 'N/A',
            codec: 'N/A'
        };

        const now = Date.now();
        let currentInboundRtp = null;
        let remoteCandidate = null;
        let localCandidate = null;

        stats.forEach(report => {
            // Find the active inbound video stream
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
                currentInboundRtp = report;
                
                // Calculate Bitrate
                const lastStats = lastInboundStats[socketId];
                if (lastStats) {
                    const bytesReceived = report.bytesReceived - lastStats.bytesReceived;
                    const timeElapsed = (now - lastStats.timestamp) / 1000; // in seconds
                    if (timeElapsed > 0) {
                        const bitrate = Math.round((bytesReceived * 8) / timeElapsed / 1000); // in kbps
                        metrics.bitrate = `${bitrate} kbps`;
                    }
                }
                lastInboundStats[socketId] = { bytesReceived: report.bytesReceived, timestamp: now };
                
                // Get other metrics from this report
                metrics.packetsLost = report.packetsLost || 0;
                metrics.jitter = report.jitter ? (report.jitter * 1000).toFixed(2) + ' ms' : 'N/A';
                metrics.resolution = (report.frameWidth && report.frameHeight) ? `${report.frameWidth}x${report.frameHeight}` : 'N/A';
                metrics.fps = report.framesPerSecond ? Math.round(report.framesPerSecond) : 'N/A';
                
                // Find codec
                if(report.codecId) {
                    const codec = stats.get(report.codecId);
                    if (codec) {
                        metrics.codec = codec.mimeType.split('/')[1] || 'N/A';
                    }
                }
            }
            
            // Find candidate pair to get RTT
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                if (report.currentRoundTripTime) {
                    metrics.latency = (report.currentRoundTripTime * 1000).toFixed(0) + ' ms';
                }
            }
        });
        
        displayStats(socketId, metrics);
    }
    
    function displayStats(socketId, metrics) {
        const statsDisplay = document.getElementById(`stats-${socketId}`);
        if (statsDisplay) {
            statsDisplay.innerHTML = `
                Latency: ${metrics.latency}<br>
                Jitter: ${metrics.jitter}<br>
                Lost: ${metrics.packetsLost}<br>
                Bitrate: ${metrics.bitrate}<br>
                Res: ${metrics.resolution}<br>
                FPS: ${metrics.fps}<br>
                Codec: ${metrics.codec}
            `;
        }
    }

}); // End DOMContentLoaded