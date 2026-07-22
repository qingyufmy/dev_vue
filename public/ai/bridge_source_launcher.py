# -*- coding: utf-8 -*-
"""Administrator dialog and launcher for an isolated observer-source Bridge."""
import os
import subprocess
import sys

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QCheckBox, QDialog, QFileDialog, QFormLayout, QHBoxLayout, QLabel, QLineEdit,
    QPushButton, QVBoxLayout,
)


def launch_bridge_profile(bridge_script, slug, frozen=False):
    command = [sys.executable, "--profile", slug] if frozen else [sys.executable, bridge_script, "--profile", slug]
    flags = subprocess.CREATE_NEW_CONSOLE if os.name == "nt" and not frozen else 0
    return subprocess.Popen(command, cwd=os.path.dirname(bridge_script), creationflags=flags)


class NewObserverSourceDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("新增观摩源")
        self.setMinimumWidth(560)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 18, 20, 18)
        layout.setSpacing(14)
        title = QLabel("启动独立桥接与 MT5")
        title.setFont(QFont("Segoe UI", 17, QFont.Bold))
        hint = QLabel("使用网站中创建的专用桥接源账号。每个观摩源必须选择不同的 MT5 安装目录，避免账户和行情串线。")
        hint.setProperty("muted", True)
        hint.setWordWrap(True)
        layout.addWidget(title)
        layout.addWidget(hint)

        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignLeft)
        form.setHorizontalSpacing(14)
        form.setVerticalSpacing(11)
        self.profile_slug = QLineEdit()
        self.profile_slug.setPlaceholderText("例如 source-a")
        self.profile_name = QLineEdit()
        self.profile_name.setPlaceholderText("例如 一号观摩源")
        self.account = QLineEdit()
        self.account.setPlaceholderText("专用桥接源账号邮箱")
        self.password = QLineEdit()
        self.password.setEchoMode(QLineEdit.Password)
        self.password.setPlaceholderText("专用桥接源账号密码")
        password_row = QHBoxLayout()
        show_password = QCheckBox("显示")
        show_password.toggled.connect(lambda checked: self.password.setEchoMode(QLineEdit.Normal if checked else QLineEdit.Password))
        password_row.addWidget(self.password, 1)
        password_row.addWidget(show_password)
        path_row = QHBoxLayout()
        self.mt5_path = QLineEdit()
        self.mt5_path.setPlaceholderText("包含 terminal64.exe 的独立目录")
        browse = QPushButton("选择")
        browse.setProperty("secondary", True)
        browse.clicked.connect(self._browse_mt5)
        path_row.addWidget(self.mt5_path, 1)
        path_row.addWidget(browse)
        form.addRow("档案标识", self.profile_slug)
        form.addRow("显示名称", self.profile_name)
        form.addRow("源账号", self.account)
        form.addRow("密码", password_row)
        form.addRow("独立 MT5", path_row)
        layout.addLayout(form)

        self.error = QLabel("")
        self.error.setProperty("error", True)
        self.error.setWordWrap(True)
        self.error.setVisible(False)
        layout.addWidget(self.error)
        actions = QHBoxLayout()
        actions.addStretch()
        cancel = QPushButton("取消")
        cancel.setProperty("secondary", True)
        cancel.clicked.connect(self.reject)
        self.submit = QPushButton("创建并启动")
        self.submit.setDefault(True)
        actions.addWidget(cancel)
        actions.addWidget(self.submit)
        layout.addLayout(actions)

    def _browse_mt5(self):
        path = QFileDialog.getExistingDirectory(self, "选择独立 MT5 安装目录", self.mt5_path.text() or "C:\\")
        if path:
            self.mt5_path.setText(os.path.normpath(path))

    def values(self):
        return {
            "slug": self.profile_slug.text().strip(),
            "name": self.profile_name.text().strip(),
            "account": self.account.text().strip(),
            "password": self.password.text(),
            "mt5_path": os.path.normpath(self.mt5_path.text().strip()),
        }

    def show_error(self, message):
        self.error.setText(str(message))
        self.error.setVisible(True)
        self.set_submitting(False)

    def set_submitting(self, submitting):
        self.submit.setEnabled(not submitting)
        self.submit.setText("正在验证并启动…" if submitting else "创建并启动")
