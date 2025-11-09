// Client-side logic for the WebRTC chat application

document.addEventListener('DOMContentLoaded', () => {

    // --- 0. State and DOM Elements ---
    
    // Connection
    // const socket = io('https://your-webrtc-backend-url.onrender.com'); // For deployment
    const socket = io(); // For local development

    // Local state
    let localStream = null;
    let localUsername = '';
    let currentRoom = '';
    const peerConnections = {}; // Stores all RTCPeerConnection objects, keyed by peerId
    let statsInterval = null; // Holds the interval ID for stat monitoring
    let lastStatsReport = {}; // Stores the last stats report for calculating bitrate

    // STUN server configuration (Google's public STUN servers)
    const iceConfig = {
        'iceServers': [
            { 'urls': 'stun:stun.l.google.com:19302' },
            { 'urls': 'stun:stun1.l.google.com:19302' }
        ]
    };

    // DOM Elements - Join View
    const joinContainer = document.getElementById('join-container');
    const usernameInput = document.getElementById('username-input');
    const roomInput = document.getElementById('room-input');
    const joinBtn = document.getElementById('join-btn');

    // DOM Elements - App View
    const appContainer = document.getElementById('app-container');
    const videoGrid = document.getElementById('video-grid');
    const toggleMicBtn = document.getElementById('toggle-mic-btn');
    const toggleCamBtn = document.getElementById('toggle-cam-btn');
    const exitBtn = document.getElementById('exit-btn');
    
    // DOM Elements - Chat
    const chatContainer = document.getElementById('chat-container');
    const messages = document.getElementById('messages');
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    
    // File input element
    const fileInput = document.getElementById('file-input');


    // --- 1. Join Logic ---

    joinBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const room = roomInput.value.trim();

        if (username && room) {
            localUsername = username;
            currentRoom = room;
            
            try {
                // Get local media stream
                localStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: true
                });

                // Display local video
                addVideoStream(socket.id, localStream, localUsername, true); // true = isLocal

                // Show the main app and hide the join form
                joinContainer.style.display = 'none';
                appContainer.style.display = 'flex';

                // Update button states
                toggleCamBtn.classList.add('active');
                toggleMicBtn.classList.add('active');

                // Emit 'join-room' event to the server
                socket.emit('join-room', { username, room });

                // Start monitoring stats
                startMonitoringStats();

            } catch (error) {
                console.error('Error accessing media devices.', error);
                alert('Could not access camera or microphone. Please check permissions.');
            }
        } else {
            alert('Please enter a username and room code.');
        }
    });

    // --- 2. Socket Event Handlers ---

    // Successfully joined room
    socket.on('joined-room', ({ room, otherUsers }) => {
        console.log(`Successfully joined room ${room}`);
        
        // For each existing user, create a new peer connection and send them an offer
        otherUsers.forEach(user => {
            console.log(`Found existing user, creating offer for: ${user.username}`);
            const pc = createPeerConnection(user.id, user.username);
            sendOffer(pc, user.id);
        });
    });

    // A new user has joined the room
    socket.on('user-joined', ({ id, username }) => {
        console.log(`User ${username} (id: ${id}) joined the room.`);
        addNotification(`${username} joined the room.`);
        
        // We don't create a peer connection here. We wait for their offer.
        // The new user is responsible for initiating offers to existing users.
    });

    // Receive an offer from a new user
    socket.on('offer', async ({ source, sdp, username }) => {
        console.log(`Received offer from ${username} (id: ${source})`);
        const pc = createPeerConnection(source, username);
        
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            
            // Create an answer
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // Send the answer back to the source user
            socket.emit('answer', {
                target: source,
                sdp: pc.localDescription
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    });

    // Receive an answer from a peer
    socket.on('answer', async ({ source, sdp }) => {
        console.log(`Received answer from ${source}`);
        const pc = peerConnections[source];
        if (pc) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            } catch (error) {
                console.error('Error setting remote description from answer:', error);
            }
        }
    });

    // Receive an ICE candidate from a peer
    socket.on('ice-candidate', async ({ source, candidate }) => {
        // console.log(`Received ICE candidate from ${source}`);
        const pc = peerConnections[source];
        if (pc && candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                console.error('Error adding received ICE candidate:', error);
            }
        }
    });

    // A user has left the room
    socket.on('user-left', ({ id, username }) => {
        console.log(`User ${username} (id: ${id}) left the room.`);
        addNotification(`${username} left the room.`);
        
        // Clean up the connection and UI
        if (peerConnections[id]) {
            peerConnections[id].close();
            delete peerConnections[id];
        }
        
        // Remove peer from stats tracking
        if (lastStatsReport[id]) {
            delete lastStatsReport[id];
        }

        const videoElement = document.getElementById(`video-${id}`);
        if (videoElement) {
            videoElement.remove();
        }
    });

    // --- 3. Chat and File Handlers ---

    // Listen for new chat messages
    socket.on('new-message', ({ username, message }) => {
        // *** FIX: Check if the username matches localUsername to style correctly ***
        addMessage(username, message, username === localUsername);
    });

    // Listen for new files
    socket.on('new-file', ({ username, file, filename, filetype }) => {
        addFileMessage(username, file, filename, filetype, username === localUsername);
    });

    // Handle chat form submission
    messageForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = messageInput.value.trim();
        
        if (message) {
            // Emit the message to the server
            socket.emit('chat-message', { room: currentRoom, message });
            
            // *** FIX: Removed optimistic addMessage to prevent duplicates ***
            // addMessage(localUsername, message, true); // This line caused the bug
            
            // Clear the input
            messageInput.value = '';
        }
    });

    // Handle file input selection
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            console.log(`Sending file: ${file.name}, type: ${file.type}, size: ${file.size}`);

            // We send the file as an ArrayBuffer
            const reader = new FileReader();
            reader.onload = (event) => {
                const buffer = event.target.result;
                
                // Emit the file to the server
                socket.emit('file-share', {
                    room: currentRoom,
                    file: buffer,
                    filename: file.name,
                    filetype: file.type
                });

                // *** FIX: Removed optimistic addFileMessage to prevent duplicates ***
                // addFileMessage(localUsername, buffer, file.name, file.type, true);
            };
            reader.readAsArrayBuffer(file);
            
            // Reset the file input to allow sending the same file again
            e.target.value = null;
        }
    });

    // --- 4. Local Media Controls ---

    // Toggle Microphone
    toggleMicBtn.addEventListener('click', () => {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            if (audioTrack.enabled) {
                toggleMicBtn.textContent = 'Mute Mic';
                toggleMicBtn.classList.add('active');
            } else {
                toggleMicBtn.textContent = 'Unmute Mic';
                toggleMicBtn.classList.remove('active');
            }
        }
    });

    // Toggle Camera
    toggleCamBtn.addEventListener('click', () => {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            if (videoTrack.enabled) {
                toggleCamBtn.textContent = 'Hide Camera';
                toggleCamBtn.classList.add('active');
            } else {
                toggleCamBtn.textContent = 'Show Camera';
                toggleCamBtn.classList.remove('active');
            }
        }
    });

    // Exit Room
    exitBtn.addEventListener('click', () => {
        // Stop the stats interval
        if (statsInterval) {
            clearInterval(statsInterval);
        }
        // Reload the page to disconnect and return to the join screen
        window.location.reload();
    });

    // --- 5. WebRTC Helper Functions ---

    /**
     * Creates, configures, and stores a new RTCPeerConnection object.
     */
    function createPeerConnection(peerId, peerUsername) {
        const pc = new RTCPeerConnection(iceConfig);

        // Store the connection
        peerConnections[peerId] = pc;

        // Add local stream tracks to the connection
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }

        // Handle incoming remote stream
        pc.ontrack = (event) => {
            console.log(`Received remote track from ${peerUsername}`);
            if (event.streams && event.streams[0]) {
                addVideoStream(peerId, event.streams[0], peerUsername, false);
            }
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                // Send the candidate to the other peer
                socket.emit('ice-candidate', {
                    target: peerId,
                    candidate: event.candidate
                });
            }
        };

        // Handle connection state changes (for debugging)
        pc.onconnectionstatechange = (event) => {
            console.log(`Connection state with ${peerUsername} (${peerId}): ${pc.connectionState}`);
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
                // Optional: handle peer disconnection more gracefully
            }
        };

        return pc;
    }

    /**
     * Creates and sends an SDP offer to a target peer.
     */
    async function sendOffer(pc, targetId) {
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            // Send the offer to the target user
            socket.emit('offer', {
                target: targetId,
                sdp: pc.localDescription
            });
        } catch (error) {
            console.error('Error creating or sending offer:', error);
        }
    }

    // --- 6. Stats Monitoring (UPDATED) ---
    
    /**
     * Periodically fetches and displays WebRTC stats for all peers.
     */
    function startMonitoringStats() {
        const STATS_INTERVAL_MS = 3000; // Check stats every 3 seconds

        statsInterval = setInterval(async () => {
            // Check stats for each peer connection
            for (const peerId in peerConnections) {
                const pc = peerConnections[peerId];
                
                // Only check connections that are established
                if (pc && (pc.connectionState === 'connected')) {
                    try {
                        const statsReport = await pc.getStats();
                        let peerStats = {
                            latency: 'N/A',
                            jitter: 'N/A',
                            packetsLost: 'N/A',
                            framerate: 'N/A',
                            bitrate: 'N/A',
                            resolution: 'N/A',
                            codec: 'N/A'
                        };

                        let inboundRtpReport = null;
                        let remoteCandidateReport = null;

                        statsReport.forEach(report => {
                            // Find the active candidate pair (for Latency/RTT)
                            if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
                                peerStats.latency = (report.currentRoundTripTime * 1000).toFixed(0); // in ms
                                if (report.remoteCandidateId) {
                                    remoteCandidateReport = statsReport.get(report.remoteCandidateId);
                                }
                            }
                            
                            // Find the inbound video stream stats
                            if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
                                inboundRtpReport = report;
                                peerStats.jitter = report.jitter ? (report.jitter * 1000).toFixed(2) : 'N/A'; // in ms
                                peerStats.packetsLost = report.packetsLost;
                                if (report.framesPerSecond) {
                                    peerStats.framerate = report.framesPerSecond;
                                }
                                if (report.frameWidth && report.frameHeight) {
                                    peerStats.resolution = `${report.frameWidth}x${report.frameHeight}`;
                                }
                                if (report.codecId) {
                                    const codec = statsReport.get(report.codecId);
                                    peerStats.codec = codec ? codec.mimeType.split('/')[1] : 'N/A';
                                }
                            }
                        });

                        // Calculate Bitrate
                        if (inboundRtpReport) {
                            const lastReport = lastStatsReport[peerId];
                            if (lastReport && lastReport.inboundRtpReport) {
                                // Calculate bytes received since last check
                                const bytesReceived = inboundRtpReport.bytesReceived - lastReport.inboundRtpReport.bytesReceived;
                                // Calculate time elapsed in seconds
                                const timeElapsed = (inboundRtpReport.timestamp - lastReport.inboundRtpReport.timestamp) / 1000;
                                
                                if (timeElapsed > 0) {
                                    const bitrate = (bytesReceived * 8) / timeElapsed / 1000; // in kbps
                                    peerStats.bitrate = bitrate.toFixed(0);
                                }
                            }
                            // Store current report for next calculation
                            lastStatsReport[peerId] = { inboundRtpReport };
                        }

                        // Display the stats
                        displayStats(peerId, peerStats);
                    
                    } catch (error) {
                        console.error(`Error getting stats for peer ${peerId}:`, error);
                    }
                }
            }
        }, STATS_INTERVAL_MS);
    }

    /**
     * Updates the UI with the latest stats for a peer.
     */
    function displayStats(peerId, stats) {
        const videoContainer = document.getElementById(`video-${peerId}`);
        if (!videoContainer) return;

        let statsDisplay = videoContainer.querySelector('.stats-display');
        if (!statsDisplay) {
            // Create the stats display element if it doesn't exist
            statsDisplay = document.createElement('div');
            statsDisplay.classList.add('stats-display');
            videoContainer.appendChild(statsDisplay);
        }

        // Update the stats content
        statsDisplay.innerHTML = `
            Latency: ${stats.latency} ms<br>
            Jitter: ${stats.jitter} ms<br>
            Lost: ${stats.packetsLost}<br>
            Bitrate: ${stats.bitrate} kbps<br>
            Res: ${stats.resolution}<br>
            FPS: ${stats.framerate}<br>
            Codec: ${stats.codec}
        `.trim();
    }


    // --- 7. DOM Manipulation Functions ---

    /**
     * Adds a video stream to the video grid.
     */
    function addVideoStream(id, stream, username, isLocal = false) {
        // Prevent duplicate video elements
        if (document.getElementById(`video-${id}`)) {
            return;
        }

        const videoContainer = document.createElement('div');
        videoContainer.classList.add('video-container');
        videoContainer.id = `video-${id}`;

        const video = document.createElement('video');
        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        
        if (isLocal) {
            video.muted = true; // Mute local video to prevent echo
            video.style.transform = 'scaleX(-1)'; // Flip local video horizontally
        }

        const usernameTag = document.createElement('div');
        usernameTag.classList.add('username-tag');
        usernameTag.textContent = isLocal ? `${username} (You)` : username;

        videoContainer.appendChild(video);
        videoContainer.appendChild(usernameTag);
        videoGrid.appendChild(videoContainer);
    }

    /**
     * Adds a text message to the chat UI.
     */
    function addMessage(username, message, isMine) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', isMine ? 'mine' : 'other');
        
        messageElement.innerHTML = `<strong>${username}</strong>${message}`;
        
        messages.appendChild(messageElement);
        scrollToBottom();
    }

    /**
     * Adds a file message (image preview or download link) to the chat UI.
     */
    function addFileMessage(username, fileBuffer, filename, filetype, isMine) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', isMine ? 'mine' : 'other');

        // Create a blob from the ArrayBuffer
        const blob = new Blob([fileBuffer], { type: filetype });
        const fileUrl = URL.createObjectURL(blob);

        let fileElement;
        if (filetype.startsWith('image/')) {
            // It's an image, create an <img> preview
            fileElement = document.createElement('img');
            fileElement.src = fileUrl;
            fileElement.classList.add('file-preview');
            // Optional: allow clicking image to open in new tab
            fileElement.onclick = () => window.open(fileUrl, '_blank');
        } else {
            // It's another file type, create a download link
            fileElement = document.createElement('a');
            fileElement.href = fileUrl;
            fileElement.download = filename; // Set the download attribute
            fileElement.textContent = `Download: ${filename}`;
            fileElement.classList.add('file-download');
        }

        messageElement.innerHTML = `<strong>${username}</strong>`;
        messageElement.appendChild(fileElement);
        
        messages.appendChild(messageElement);
        scrollToBottom();
    }

    /**
     * Adds a notification message (e.g., "User joined") to the chat UI.
     */
    function addNotification(message) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('notification');
        messageElement.textContent = message;
        messages.appendChild(messageElement);
        scrollToBottom();
    }

    /**
     * Helper function to scroll the chat box to the bottom.
     */
    function scrollToBottom() {
        messages.scrollTop = messages.scrollHeight;
    }

});