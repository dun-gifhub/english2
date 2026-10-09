import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Navbar } from './components/Navbar';
import { TeacherPasscodeModal } from './components/TeacherPasscodeModal';
import { NeonRenderModal } from './components/NeonRenderModal';
import { HomeScreen } from './screens/HomeScreen';
import { TapGameScreen } from './screens/TapGameScreen';
import { TeacherPortalScreen } from './screens/TeacherPortalScreen';
import { AssignmentQuizScreen } from './screens/AssignmentQuizScreen';
import { DictionaryScreen } from './screens/DictionaryScreen';
import { FriendsScreen } from './screens/FriendsScreen';
import { CallRoomScreen } from './screens/CallRoomScreen';
import { LeaderboardScreen } from './screens/LeaderboardScreen';
import { AuthScreen } from './screens/AuthScreen';
import { UnitTopic, TeacherAssignment } from './types';

function MainApp() {
  const { currentUser, setRole, addXpAndScore, setCurrentActivity } = useApp();

  const [activeTab, setActiveTab] = useState<string>('home');
  const [activeUnitToPlay, setActiveUnitToPlay] = useState<UnitTopic | null>(null);
  const [activeAssignmentToTake, setActiveAssignmentToTake] = useState<TeacherAssignment | null>(null);
  const [showTeacherModal, setShowTeacherModal] = useState<boolean>(false);

  // Sync activity with tab changes
  React.useEffect(() => {
    if (!currentUser) return;
    if (activeUnitToPlay) {
      setCurrentActivity(`Đang đấu từ: ${activeUnitToPlay.title} (Lớp ${activeUnitToPlay.grade})`);
    } else if (activeAssignmentToTake) {
      setCurrentActivity(`Đang làm bài: ${activeAssignmentToTake.title} (K${activeAssignmentToTake.grade})`);
    } else if (activeTab === 'dict') {
      setCurrentActivity('Đang tra cứu từ điển Anh - Việt');
    } else if (activeTab === 'friends') {
      setCurrentActivity('Đang kết nối danh sách bạn bè');
    } else if (activeTab === 'callRoom') {
      setCurrentActivity('Đang ở phòng học nhóm trực tuyến');
    } else if (activeTab === 'leaderboard') {
      setCurrentActivity('Đang xem Bảng Vàng vinh danh');
    } else if (activeTab === 'teacher') {
      setCurrentActivity(
        currentUser.role === 'ADMIN'
          ? 'Quản trị hệ thống & Giám sát online'
          : 'Góc Giáo viên (Soạn đề & Quản lý)'
      );
    } else {
      setCurrentActivity('Đang ôn luyện tiếng Anh');
    }
  }, [activeTab, activeUnitToPlay, activeAssignmentToTake, currentUser]);

  if (!currentUser) {
    return <AuthScreen />;
  }

  // Active game subscreen
  if (activeUnitToPlay) {
    return (
      <TapGameScreen
        unit={activeUnitToPlay}
        onGameOver={(_score, xpEarned) => {
          addXpAndScore(xpEarned);
        }}
        onBack={() => {
          setActiveUnitToPlay(null);
          setCurrentActivity('Đang ôn luyện tiếng Anh');
        }}
      />
    );
  }

  // Active quiz subscreen
  if (activeAssignmentToTake) {
    return (
      <AssignmentQuizScreen
        assignment={activeAssignmentToTake}
        onFinish={(xpEarned) => {
          addXpAndScore(xpEarned);
        }}
        onBack={() => {
          setActiveAssignmentToTake(null);
          setCurrentActivity('Đang ôn luyện tiếng Anh');
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#0D1B2A] text-[#F8F9FA] flex flex-col">
      <Navbar
        currentTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
        }}
        onRequestTeacherModal={() => setShowTeacherModal(true)}
      />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 pt-4 sm:pt-6">
        {activeTab === 'home' && (
          <HomeScreen
            onPlayUnit={(unit) => {
              setActiveUnitToPlay(unit);
              setCurrentActivity(`Đang đấu từ: ${unit.title} (Lớp ${unit.grade})`);
            }}
            onTakeAssignment={(assign) => {
              setActiveAssignmentToTake(assign);
              setCurrentActivity(`Đang làm bài: ${assign.title} (K${assign.grade})`);
            }}
            onOpenTeacherPortal={() => setActiveTab('teacher')}
          />
        )}

        {activeTab === 'dict' && <DictionaryScreen />}

        {activeTab === 'teacher' && (currentUser.role === 'TEACHER' || currentUser.role === 'ADMIN') && (
          <TeacherPortalScreen
            onSwitchToStudentRole={() => {
              setRole('STUDENT');
              setActiveTab('home');
            }}
          />
        )}

        {activeTab === 'friends' && (
          <FriendsScreen
            onOpenCallRoom={() => setActiveTab('callRoom')}
          />
        )}

        {activeTab === 'callRoom' && (
          <CallRoomScreen
            onLeave={() => setActiveTab('friends')}
          />
        )}

        {activeTab === 'leaderboard' && <LeaderboardScreen />}
      </main>

      {/* Teacher Passcode Modal */}
      <TeacherPasscodeModal
        isOpen={showTeacherModal}
        onClose={() => setShowTeacherModal(false)}
        onSuccess={() => {
          setRole('TEACHER');
          setShowTeacherModal(false);
          setActiveTab('teacher');
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <MainApp />
    </AppProvider>
  );
}
