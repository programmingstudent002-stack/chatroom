const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// public 폴더의 index.html 제공
app.use(express.static(path.join(__dirname, 'public')));

// 방장 암호 (Render 환경변수 HOST_PASSWORD가 없으면 기본값 '1234' 사용)
const HOST_PASSWORD = process.env.HOST_PASSWORD || '1234';

// 실시간 방 상태 관리 (메모리 저장)
let roomState = {
  hostSocketId: null,
  participants: [], // { id, name, isHost }
  waitingList: [],  // { id, name }
  notice: '오늘도 수고 많았어. 편하게 쉬다 가자 🌌',
  messages: [
    {
      sender: '안내',
      text: '밤하늘 아래 조용한 실시간 대화가 연결되었습니다.',
      isSystem: true
    }
  ]
};

// 현재 참여자 목록과 대기자 목록을 방에 브로드캐스트
function syncRoomState() {
  io.to('chat-room').emit('room-state', {
    participants: roomState.participants.map(p => p.name),
    notice: roomState.notice
  });

  if (roomState.hostSocketId) {
    io.to(roomState.hostSocketId).emit('waiting-list-update', roomState.waitingList);
  }
}

io.on('connection', (socket) => {
  // 1. 방장 입장 요청
  socket.on('host-login', (password) => {
    if (password !== HOST_PASSWORD) {
      socket.emit('login-error', '방장 암호가 일치하지 않습니다.');
      return;
    }

    // 기존 방장이 있었다면 교체
    roomState.hostSocketId = socket.id;
    roomState.participants = roomState.participants.filter(p => !p.isHost);
    roomState.participants.unshift({ id: socket.id, name: '방장', isHost: true });

    socket.join('chat-room');
    socket.emit('enter-success', {
      isHost: true,
      name: '방장',
      notice: roomState.notice,
      messages: roomState.messages,
      participants: roomState.participants.map(p => p.name),
      waitingList: roomState.waitingList
    });

    const sysMsg = { sender: '안내', text: '👑 방장이 방을 열었습니다.', isSystem: true };
    roomState.messages.push(sysMsg);
    io.to('chat-room').emit('new-message', sysMsg);
    syncRoomState();
  });

  // 2. 일반 친구 입장 요청
  socket.on('guest-request', (nickname) => {
    const cleanName = (nickname || '').trim().slice(0, 12);
    if (!cleanName) {
      socket.emit('login-error', '닉네임을 입력해 주세요.');
      return;
    }

    if (!roomState.hostSocketId) {
      socket.emit('login-error', '방장이 아직 들어오지 않았어요. 방장이 먼저 입장해야 합니다!');
      return;
    }

    // 중복 대기 제거 후 추가
    roomState.waitingList = roomState.waitingList.filter(w => w.id !== socket.id);
    roomState.waitingList.push({ id: socket.id, name: cleanName });

    socket.emit('waiting-approved-pending', cleanName);
    io.to(roomState.hostSocketId).emit('waiting-list-update', roomState.waitingList);
  });

  // 3. 방장의 입장 수락 / 거절 처리
  socket.on('handle-request', ({ targetId, accept }) => {
    if (socket.id !== roomState.hostSocketId) return;

    const targetIndex = roomState.waitingList.findIndex(w => w.id === targetId);
    if (targetIndex === -1) return;

    const [guest] = roomState.waitingList.splice(targetIndex, 1);
    const targetSocket = io.sockets.sockets.get(targetId);

    if (accept && targetSocket) {
      roomState.participants.push({ id: targetId, name: guest.name, isHost: false });
      targetSocket.join('chat-room');

      targetSocket.emit('enter-success', {
        isHost: false,
        name: guest.name,
        notice: roomState.notice,
        messages: roomState.messages,
        participants: roomState.participants.map(p => p.name),
        waitingList: []
      });

      const sysMsg = { sender: '안내', text: `🌙 ${guest.name}님이 방에 들어왔습니다.`, isSystem: true };
      roomState.messages.push(sysMsg);
      io.to('chat-room').emit('new-message', sysMsg);
    } else if (targetSocket) {
      targetSocket.emit('request-rejected', '방장이 입장을 거절했습니다.');
    }

    syncRoomState();
  });

  // 4. 실시간 메시지 전송
  socket.on('send-message', (text) => {
    const participant = roomState.participants.find(p => p.id === socket.id);
    if (!participant || !text || !text.trim()) return;

    const msgObj = {
      sender: participant.name,
      senderId: socket.id,
      text: text.trim(),
      isSystem: false
    };

    roomState.messages.push(msgObj);
    if (roomState.messages.length > 100) {
      roomState.messages.shift(); // 최근 100개 메시지 유지
    }

    io.to('chat-room').emit('new-message', msgObj);
  });

  // 5. 방장 공지 변경
  socket.on('update-notice', (newNotice) => {
    if (socket.id !== roomState.hostSocketId) return;
    if (!newNotice || !newNotice.trim()) return;

    roomState.notice = newNotice.trim();
    const sysMsg = { sender: '안내', text: '📢 방장이 새 공지를 등록했습니다.', isSystem: true };
    roomState.messages.push(sysMsg);

    io.to('chat-room').emit('notice-updated', roomState.notice);
    io.to('chat-room').emit('new-message', sysMsg);
  });

  // 6. 방장 방 닫기
  socket.on('close-room', () => {
    if (socket.id !== roomState.hostSocketId) return;

    io.to('chat-room').emit('room-closed', '방장이 방을 닫았습니다. 입구로 이동합니다.');
    
    // 모든 소켓 방에서 내보내기 및 상태 초기화
    io.in('chat-room').socketsLeave('chat-room');
    roomState = {
      hostSocketId: null,
      participants: [],
      waitingList: [],
      notice: '오늘도 수고 많았어. 편하게 쉬다 가자 🌌',
      messages: [
        { sender: '안내', text: '밤하늘 아래 조용한 실시간 대화가 연결되었습니다.', isSystem: true }
      ]
    };
  });

  // 7. 연결 종료 처리
  socket.on('disconnect', () => {
    // 대기자 목록에서 제거
    const prevWaitLen = roomState.waitingList.length;
    roomState.waitingList = roomState.waitingList.filter(w => w.id !== socket.id);
    if (prevWaitLen !== roomState.waitingList.length && roomState.hostSocketId) {
      io.to(roomState.hostSocketId).emit('waiting-list-update', roomState.waitingList);
    }

    // 참여자 목록에서 제거
    const leftUserIndex = roomState.participants.findIndex(p => p.id === socket.id);
    if (leftUserIndex !== -1) {
      const [leftUser] = roomState.participants.splice(leftUserIndex, 1);

      // 방장이 나간 경우 방 닫기 처리
      if (leftUser.isHost) {
        roomState.hostSocketId = null;
        io.to('chat-room').emit('room-closed', '방장이 나가서 방이 닫혔습니다.');
        io.in('chat-room').socketsLeave('chat-room');
        roomState.participants = [];
        roomState.waitingList = [];
      } else {
        const sysMsg = { sender: '안내', text: `${leftUser.name}님이 방을 나갔습니다.`, isSystem: true };
        roomState.messages.push(sysMsg);
        io.to('chat-room').emit('new-message', sysMsg);
        syncRoomState();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌙 쉬는 방 서버가 포트 ${PORT}에서 실행 중입니다.`);
});
